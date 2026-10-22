import "server-only";

import { z } from "zod";

import { applyTickets } from "@/lib/agents/pipeline";
import { ticketSpecSchema, toDraftTicket, typeOf } from "@/lib/agents/decomposition";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { applyTransition, createBacklogItem, deleteEpic } from "@/lib/board/service";
import { repository } from "@/lib/db";
import { validateDag } from "@/lib/domain/dag";
import { describeProblems } from "@/lib/domain/problems";
import { COLUMN_LABELS, COLUMNS, columnOf, hasActiveRun } from "@/lib/domain/status";
import { publish } from "@/lib/events/bus";
import { positionForIndex } from "@/lib/ordering";
import { rerunRedActions } from "@/lib/review/pipeline";
import { vcs } from "@/lib/vcs";

/**
 * What the board's assistant may change, and only ever after the person
 * approves it. The assistant proposes; these apply.
 *
 * Two changes cover what a PM is asked for: capture a request for the
 * Product Agent to spec, or put an already-planned piece of work straight
 * onto the board as an Epic with its tickets (a ticket list in the repo, an
 * issue list, a plan from the conversation). Tickets get the same checks
 * as the Architect Agent's: file scopes and a safe dependency graph.
 *
 * Tidying the board is the other half: moving a card goes through the same
 * rules as a person's drag, and closing one is the board's own archive (a
 * ticket) or delete (an Epic), so the assistant can do nothing there that
 * the person could not do by hand.
 *
 * Work that belongs to an Epic already on the board joins it, rather than
 * becoming an Epic of one ticket. And the assistant can act on the
 * repository the way a person on GitHub would: re-run a red check that
 * failed on its own, or open a pull request for a change it made itself.
 */

/** The only branches the assistant's own changes go on. */
export const ASSISTANT_BRANCH_PREFIX = "formic/chat-";

export const assistantActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_backlog_item"),
    request: z.string().trim().min(1).describe("The feature request, as the Product Agent should read it."),
  }),
  z.object({
    type: z.literal("create_epic_with_tickets"),
    title: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).describe("What this Epic delivers, in a sentence or two."),
    tickets: z.array(ticketSpecSchema).min(1).max(12),
  }),
  z.object({
    type: z.literal("add_tickets_to_epic"),
    epic: z.string().trim().min(1).describe("The Epic's key, as the board shows it."),
    tickets: z
      .array(ticketSpecSchema)
      .min(1)
      .max(12)
      .describe(
        "The new tickets. dependsOn may name each other's keys, or keys of tickets already on the board.",
      ),
  }),
  z.object({
    type: z.literal("rerun_ci"),
    key: z.string().trim().min(1).describe("The ticket's key, as the board shows it."),
  }),
  z.object({
    type: z.literal("open_pull_request"),
    branch: z
      .string()
      .trim()
      .startsWith(ASSISTANT_BRANCH_PREFIX)
      .describe("The branch your change is on. Formic names it; use the one it gave you."),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).describe("What changed and why, and how it was checked."),
  }),
  z.object({
    type: z.literal("move_card"),
    key: z.string().trim().min(1).describe("The card's key, as the board shows it."),
    to: z.enum(COLUMNS).describe("The column to move it to."),
  }),
  z.object({
    type: z.literal("close_card"),
    key: z.string().trim().min(1).describe("The card's key, as the board shows it."),
    reason: z.string().trim().min(1).describe("Why it is no longer needed, in a sentence."),
  }),
]);

export type AssistantAction = z.infer<typeof assistantActionSchema>;

/** A proposal's action, checked, or what is wrong with it. */
export function checkAction(
  raw: unknown,
): { ok: true; action: AssistantAction } | { ok: false; problem: string } {
  const parsed = assistantActionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problem: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    };
  }
  const action = parsed.data;
  if (action.type === "create_epic_with_tickets") {
    const tickets = action.tickets.map(toDraftTicket);
    const keys = new Set(tickets.map((t) => t.key));
    if (keys.size !== tickets.length) return { ok: false, problem: "Two tickets share a key." };
    const dag = validateDag(
      tickets.map((t) => ({ key: t.key, dependsOn: t.dependsOn, fileScope: t.fileScope })),
    );
    if (!dag.ok) {
      return {
        ok: false,
        problem: `Those tickets are not safe to run:\n${describeProblems(dag.problems)}`,
      };
    }
    return { ok: true, action };
  }
  if (action.type === "add_tickets_to_epic") {
    const tickets = action.tickets.map(toDraftTicket);
    const keys = new Set(tickets.map((t) => t.key));
    if (keys.size !== tickets.length) return { ok: false, problem: "Two tickets share a key." };
    // Keys outside the list name tickets on the board; applying checks those.
    const dag = validateDag(
      tickets.map((t) => ({ key: t.key, dependsOn: t.dependsOn.filter((d) => keys.has(d)), fileScope: t.fileScope })),
    );
    if (!dag.ok) {
      return { ok: false, problem: `Those tickets are not safe to run:\n${describeProblems(dag.problems)}` };
    }
    return { ok: true, action };
  }
  return { ok: true, action };
}

/** Makes an approved change. Returns what now exists, for the conversation. */
export async function applyAction(projectId: string, action: AssistantAction): Promise<string> {
  if (action.type === "create_backlog_item") {
    const card = await createBacklogItem(projectId, action.request);
    return `Added ${card.key} to Backlog. The Product Agent is writing its PRD.`;
  }
  if (action.type === "move_card") return moveCard(projectId, action.key, action.to);
  if (action.type === "close_card") return closeCard(projectId, action.key);
  if (action.type === "add_tickets_to_epic") return addTicketsToEpic(projectId, action.epic, action.tickets);
  if (action.type === "rerun_ci") return rerunCi(projectId, action.key);
  if (action.type === "open_pull_request") return openPullRequest(projectId, action);

  const repo = repository();
  const tickets = action.tickets.map(toDraftTicket);
  const epic = await repo.createEpic({
    projectId,
    title: action.title,
    rawRequest: action.summary,
    position: 0,
  });
  await repo.setEpicPrd(
    epic.id,
    {
      summary: action.summary,
      problem: action.summary,
      scope: tickets.map((t) => `${t.key}: ${t.title}`),
      outOfScope: [],
      technicalContext: [],
      userStories: tickets.map((t) => t.description.split("\n")[0]!.replace(/^\*\*User story:\*\* /, "")),
      successCriteria: tickets.flatMap((t) => t.acceptanceCriteria),
    },
    false,
  );

  // Planned already, so it skips Backlog and lands in To Do with its tickets.
  const positions = await repo.columnPositions(projectId, "todo");
  await repo.move({
    cardId: epic.id,
    kind: "epic",
    status: "ready",
    stalledIn: null,
    position: positionForIndex(positions, positions.length),
  });
  await publish(projectId, {
    type: "card.status",
    cardId: epic.id,
    kind: "epic",
    status: "ready",
    stalledIn: null,
    stage: 3,
    blockedReason: null,
  });
  await applyTickets(projectId, epic.id, tickets);
  return `Added ${epic.key} to To Do with ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}.`;
}

async function cardByKey(projectId: string, key: string) {
  const card = (await repository().boardCards(projectId)).find((c) => c.key === key);
  if (!card) throw new Error(`${key} is not on the board.`);
  return card;
}

async function moveCard(projectId: string, key: string, to: (typeof COLUMNS)[number]): Promise<string> {
  const card = await cardByKey(projectId, key);
  const from = columnOf(card);
  const drop = async (column: (typeof COLUMNS)[number], at: (typeof COLUMNS)[number]) => {
    const positions = await repository().columnPositions(projectId, column);
    return applyTransition(projectId, {
      cardId: card.id,
      kind: card.kind,
      from: at,
      to: column,
      position: positionForIndex(positions, positions.length),
      actor: "user",
    });
  };
  const result = await drop(to, from);
  if (!result.ok) throw new Error(result.reason);
  // A person's drag can leave a card where it cannot work, saying why. An
  // approved move either does what it said or nothing: back it goes.
  if (result.problem) {
    await drop(from, to);
    throw new Error(result.problem);
  }
  return `Moved ${key} to ${COLUMN_LABELS[to]}.`;
}

async function closeCard(projectId: string, key: string): Promise<string> {
  const repo = repository();
  const card = await cardByKey(projectId, key);
  if (card.kind === "epic") {
    const result = await deleteEpic(projectId, card.id);
    if (!result.ok) throw new Error(result.reason);
    return `Closed ${key} and its tickets.`;
  }
  const ticket = await repo.ticketDetail(card.id);
  if (!ticket) throw new Error(`${key} is not on the board.`);
  if (hasActiveRun(ticket, card)) throw new Error(`An agent is working ${key}. Stop it first.`);
  await repo.updateTicket(card.id, { archived: true });
  await publish(projectId, { type: "card.deleted", cardId: card.id, kind: "ticket", issueNumbers: [] });
  return `Archived ${key}.`;
}

/**
 * New tickets in an Epic that is already on the board. Unlike a breakdown,
 * nothing there is replaced: the tickets join the ones it has.
 */
async function addTicketsToEpic(
  projectId: string,
  epicKey: string,
  specs: Array<z.infer<typeof ticketSpecSchema>>,
): Promise<string> {
  const repo = repository();
  const epic = await cardByKey(projectId, epicKey);
  if (epic.kind !== "epic") throw new Error(`${epicKey} is a ticket, not an Epic.`);
  if (epic.status === "merged") throw new Error(`${epicKey} is finished. Make a new Epic for this work.`);

  const tickets = specs.map(toDraftTicket);
  const cards = await repo.boardCards(projectId);
  const onBoard = new Map(cards.filter((c) => c.kind === "ticket").map((c) => [c.key, c]));
  const local = new Set(tickets.map((t) => t.key));
  for (const t of tickets) {
    for (const dep of t.dependsOn) {
      if (!local.has(dep) && !onBoard.has(dep)) throw new Error(`${t.key} depends on ${dep}, which is not on the board.`);
    }
  }

  // Held to the same rule as a breakdown: what could run alongside the
  // Epic's open tickets must not share their files.
  const existing = await repo.ticketsForEpic(epic.id);
  const open = existing.filter((t) => t.status !== "merged");
  const keyFor = new Map<string, string>();
  const taken = new Set(existing.map((t) => t.key));
  let n = existing.length;
  for (const t of tickets) {
    let key = `${epicKey}-T${++n}`;
    while (taken.has(key)) key = `${epicKey}-T${++n}`;
    taken.add(key);
    keyFor.set(t.key, key);
  }
  const resolve = (k: string) => keyFor.get(k) ?? k;
  const openKeys = new Set(open.map((t) => t.key));
  const newKeys = new Set(keyFor.values());
  const dag = validateDag([
    ...open.map((t) => ({
      key: t.key,
      dependsOn: (onBoard.get(t.key)?.dependsOn ?? [])
        .map((id) => cards.find((c) => c.id === id)?.key)
        .filter((k): k is string => !!k && openKeys.has(k)),
      fileScope: t.fileScope,
    })),
    ...tickets.map((t) => ({
      key: resolve(t.key),
      dependsOn: t.dependsOn.map(resolve).filter((k) => openKeys.has(k) || newKeys.has(k)),
      fileScope: t.fileScope,
    })),
  ]);
  if (!dag.ok) throw new Error(`Those tickets would clash with ${epicKey}'s:\n${describeProblems(dag.problems)}`);

  const positions = await repo.columnPositions(projectId, "todo");
  let cursor = positions.length;
  // A ticket waits only on work that has not merged yet.
  const pending = (k: string) => local.has(k) || onBoard.get(k)?.status !== "merged";
  const made = await repo.createTickets(
    tickets.map((t) => ({
      epicId: epic.id,
      key: keyFor.get(t.key)!,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      fileScope: t.fileScope,
      size: t.size,
      storyPoints: t.storyPoints ?? null,
      needsHuman: t.needsHuman ?? null,
      ...typeOf(t),
      position: positionForIndex(positions, cursor++),
      dependsOnKeys: t.dependsOn.filter(pending).map(resolve),
    })),
  );
  // Edges to tickets made elsewhere are by id.
  const edges = tickets.flatMap((t) => {
    const ticketId = made.find((c) => c.key === keyFor.get(t.key))?.id;
    return t.dependsOn
      .filter((d) => !local.has(d) && pending(d))
      .map((d) => ({ ticketId: ticketId!, dependsOnTicketId: onBoard.get(d)!.id }));
  });
  if (edges.length) await repo.addDependencies(edges);
  await publish(projectId, { type: "card.created", cardId: epic.id, kind: "epic", epicId: epic.id });
  const keys = tickets.map((t) => keyFor.get(t.key)).join(", ");
  return `Added ${keys} to ${epicKey}.`;
}

/** A ticket's red checks, run again: for a failure that is not the code's. */
async function rerunCi(projectId: string, key: string): Promise<string> {
  const card = await cardByKey(projectId, key);
  if (card.kind !== "ticket" || !card.prNumber) throw new Error(`${key} has no pull request to run CI on.`);
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  const pull = await client.pullRequest(card.prNumber);
  const started = await rerunRedActions(client, pull.headBranch, await client.checksFor(pull.headSha));
  if (started === 0) {
    throw new Error(
      `${key} has no failed Actions check that can run again: it is green, still running, or already re-ran once and failed again.`,
    );
  }
  return `Re-running ${started === 1 ? "the failed check" : `${started} failed runs`} on ${key}'s pull request #${pull.number}.`;
}

/** The assistant's own change, as a pull request into the base branch. */
async function openPullRequest(
  projectId: string,
  action: Extract<AssistantAction, { type: "open_pull_request" }>,
): Promise<string> {
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.githubToken);
  if (!(await client.branchHead(action.branch))) throw new Error(`${action.branch} is not on GitHub any more.`);
  const pull =
    (await client.findPullRequest(action.branch)) ??
    (await client.openPullRequest({
      headBranch: action.branch,
      baseBranch: project.baseBranch,
      title: action.title,
      body: `${action.body}\n\n_Opened from the board's assistant._`,
    }));
  return `Opened pull request #${pull.number}: ${pull.url}`;
}
