import "server-only";

import type { AttachmentSummary } from "@/lib/domain/entities";

import { z } from "zod";

import { applyTickets, archivedKeysFor } from "@/lib/agents/pipeline";
import { ticketSpecSchema, toDraftTicket, typeOf } from "@/lib/agents/decomposition";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { boardPorts } from "@/lib/board/ports";
import { repository } from "@/lib/db";
import { validateDag } from "@/lib/domain/dag";
import { describeProblems } from "@/lib/domain/problems";
import { prdFromTickets } from "@/lib/domain/planned-epic";
import { COLUMN_LABELS, COLUMNS, columnOf, hasActiveRun } from "@/lib/domain/status";
import { publish } from "@/lib/events/bus";
import { positionForIndex } from "@/lib/ordering";
import { addFollowUpTicket } from "@/lib/board/follow-ups";
import { mergeByPerson, rerunRedActions, updateFromMain } from "@/lib/review/pipeline";
import { waitedOn, waitingOnReason } from "@/lib/domain/notice";
import { ask as askCardChat } from "@/lib/agents/card-chat";
import { isQuestion, PM_ANSWER_PREFIX } from "@/lib/domain/question";
import { SENTINELS, sentinel as findSentinel } from "@/lib/sentinels/roster";
import { reviseRubricCheck } from "@/lib/sentinels/service";
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
 * becoming an Epic of one ticket, even when that Epic has finished: it
 * reopens. And the assistant can act on the
 * repository the way a person on GitHub would: re-run a red check that
 * failed on its own, or open a pull request for a change it made itself.
 */

/** The only branches the assistant's own changes go on. */
export const ASSISTANT_BRANCH_PREFIX = "formic/chat-";

export const assistantActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("revise_rubric_check"),
    fix: z.string().trim().min(1).optional().describe("The id of a rubric fix an agent flagged."),
    sentinel: z.string().trim().min(1).optional().describe("Without a fix: the Sentinel's name or id."),
    check: z.string().trim().min(1).optional().describe("Without a fix: the check's id, such as 5b."),
    note: z.string().trim().min(1).optional().describe("Without a fix: what is wrong and the change the person wants."),
    current: z.string().optional().describe("The check's wording now, for the card to show."),
    proposed: z.string().optional().describe("The proposed change, for the card to show."),
  }),
  z.object({
    type: z.literal("add_follow_up"),
    ticket: z.string().trim().min(1).describe("The key of the ticket that proposed it."),
    title: z.string().trim().min(1).describe("The follow-up's title, as that ticket lists it."),
  }),
  z.object({
    type: z.literal("create_backlog_item"),
    request: z.string().trim().min(1).describe("The feature request, as the Product Agent should read it."),
    screenshots: z
      .array(z.string().min(1))
      .max(5)
      .optional()
      .describe("For a playtest note: the screenshot ids its [Playtest note] line lists, so the item carries the pictures."),
  }),
  z.object({
    type: z.literal("create_todo_item"),
    request: z.string().trim().min(1).describe("The one fix or behaviour, as the Architect Agent should read it."),
    screenshots: z
      .array(z.string().min(1))
      .max(5)
      .optional()
      .describe("For a playtest note: the screenshot ids its [Playtest note] line lists, so the ticket carries the pictures."),
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
    type: z.literal("update_branch"),
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
    unblocks: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "The key of a blocked ticket this pull request fixes, when it does. That card then waits on this pull request and updates from main by itself once it merges.",
      ),
  }),
  z.object({
    type: z.literal("move_card"),
    key: z.string().trim().min(1).describe("The card's key, as the board shows it."),
    to: z.enum(COLUMNS).describe("The column to move it to."),
  }),
  z.object({
    type: z.literal("merge_pull_request"),
    key: z.string().trim().min(1).describe("The ticket's key, as the board shows it."),
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
  if (action.type === "revise_rubric_check" && !action.fix && !(action.sentinel && action.check && action.note)) {
    return { ok: false, problem: "Name the flagged fix, or the Sentinel, the check and the change." };
  }
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
export async function applyAction(projectId: string, action: AssistantAction, approvedBy?: string): Promise<string> {
  if (action.type === "revise_rubric_check") return reviseRubric(projectId, action, approvedBy);
  if (action.type === "create_todo_item") {
    const shots = await ownScreenshots(projectId, action.screenshots ?? []);
    const card = await boardPorts().service.createTodoItem(projectId, action.request);
    // Copied, not moved: the note keeps its picture in the chat.
    for (const shot of shots) {
      const content = await repository().attachmentContent(shot.id);
      if (!content) continue;
      await repository().createAttachment({
        projectId,
        ticketId: card.id,
        filename: shot.filename,
        mimeType: content.mimeType,
        kind: "image",
        size: content.bytes.length,
        bytes: content.bytes,
      });
    }
    return `Added ${card.key} to To Do. The Architect Agent is drafting it.`;
  }
  if (action.type === "create_backlog_item") {
    const shots = await ownScreenshots(projectId, action.screenshots ?? []);
    const card = await boardPorts().service.createBacklogItem(projectId, action.request);
    // Copied, not moved: the note keeps its picture in the chat.
    for (const shot of shots) {
      const content = await repository().attachmentContent(shot.id);
      if (!content) continue;
      await repository().createAttachment({
        projectId,
        epicId: card.id,
        filename: shot.filename,
        mimeType: content.mimeType,
        kind: "image",
        size: content.bytes.length,
        bytes: content.bytes,
      });
    }
    return `Added ${card.key} to Backlog. The Product Agent is writing its PRD.`;
  }
  if (action.type === "add_follow_up") return addFollowUp(projectId, action);
  if (action.type === "move_card") return moveCard(projectId, action.key, action.to);
  if (action.type === "close_card") return closeCard(projectId, action.key);
  if (action.type === "merge_pull_request") return mergePullRequest(projectId, action.key);
  if (action.type === "add_tickets_to_epic") return addTicketsToEpic(projectId, action.epic, action.tickets);
  if (action.type === "rerun_ci") return rerunCi(projectId, action.key);
  if (action.type === "update_branch") return updateBranch(projectId, action.key);
  if (action.type === "open_pull_request") return openPullRequest(projectId, action);

  const repo = repository();
  const tickets = action.tickets.map(toDraftTicket);
  const epic = await repo.createEpic({
    projectId,
    title: action.title,
    rawRequest: action.summary,
    position: 0,
  });
  await placePlannedEpic(projectId, epic.id, { summary: action.summary, tickets });
  await applyTickets(projectId, epic.id, tickets);
  return `Added ${epic.key} to To Do with ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}.`;
}

/**
 * An Epic that arrives already broken down (the PM's create_epic, or its
 * approved create_epic_with_tickets): it gets a plan from its tickets and
 * skips Backlog, landing in To Do beside them, ready to run. Without this it
 * would sit in Backlog waiting for a Product Agent that never needs to run.
 */
export async function placePlannedEpic(
  projectId: string,
  epicId: string,
  plan: { summary: string; tickets: ReadonlyArray<{ key: string; title: string; description: string; acceptanceCriteria: string[] }> },
): Promise<void> {
  const repo = repository();
  await repo.setEpicPrd(epicId, prdFromTickets(plan.summary, plan.tickets), false);
  const positions = await repo.columnPositions(projectId, "todo");
  await repo.move({
    cardId: epicId,
    kind: "epic",
    status: "ready",
    stalledIn: null,
    position: positionForIndex(positions, positions.length),
  });
  await publish(projectId, {
    type: "card.status",
    cardId: epicId,
    kind: "epic",
    status: "ready",
    stalledIn: null,
    stage: 3,
    blockedReason: null,
  });
}

/** The source ticket and the index of the follow-up an add_follow_up names. */
/** The screenshots named that really are on this board's playtest notes: a model cannot name another board's. */
async function ownScreenshots(projectId: string, asked: string[]): Promise<AttachmentSummary[]> {
  if (!asked.length) return [];
  const { messages } = await repository().assistantMessages(projectId, { limit: 500 });
  const known = new Map(
    messages.filter((m) => m.playtestId).flatMap((m) => m.attachments.filter((a) => a.kind === "image").map((a) => [a.id, a] as const)),
  );
  return [...new Set(asked)].flatMap((id) => (known.has(id) ? [known.get(id)!] : []));
}

async function followUpOf(projectId: string, action: Extract<AssistantAction, { type: "add_follow_up" }>) {
  const card = await cardByKey(projectId, action.ticket);
  const ticket = await repository().ticketDetail(card.id);
  if (!ticket) throw new Error(`${action.ticket} is not on the board.`);
  const index = ticket.followUps.findIndex((f) => f.title.toLowerCase() === action.title.toLowerCase());
  return { ticket, index };
}

/** A proposed follow-up becomes a ticket, and the source remembers it. */
async function addFollowUp(
  projectId: string,
  action: Extract<AssistantAction, { type: "add_follow_up" }>,
): Promise<string> {
  const { ticket, index } = await followUpOf(projectId, action);
  const followUp = ticket.followUps[index];
  const kind = followUp?.outcome?.kind;
  if (!followUp || (kind !== "pending" && kind !== "proposed")) {
    throw new Error(`"${action.title}" was already decided on ${action.ticket}.`);
  }
  const created = await addFollowUpTicket(projectId, ticket, followUp);
  const followUps = ticket.followUps.map((f, i) =>
    i === index ? { ...f, outcome: { kind: "added" as const, key: created.key, cardId: created.id, announced: true } } : f,
  );
  await repository().updateTicket(ticket.id, { followUps });
  return `Added ${created.key}.`;
}

/** The person dismissed an add_follow_up proposal: its follow-up is dismissed too. */
export async function dismissAction(projectId: string, action: AssistantAction): Promise<void> {
  if (action.type === "revise_rubric_check") {
    if (!action.fix) return;
    const fix = await repository().rubricFix(action.fix);
    if (fix && fix.projectId === projectId && (fix.status === "flagged" || fix.status === "proposed")) {
      await repository().updateRubricFix(fix.id, { status: "declined" });
    }
    return;
  }
  if (action.type !== "add_follow_up") return;
  const { ticket, index } = await followUpOf(projectId, action);
  if (index < 0) return;
  const followUps = ticket.followUps.map((f, i) => (i === index ? { ...f, outcome: { kind: "dismissed" as const } } : f));
  await repository().updateTicket(ticket.id, { followUps });
}

/**
 * The person approved a rubric change: the fix records who and when, and the
 * Sentinel revises that one check. A fix already decided is not applied again.
 */
async function reviseRubric(
  projectId: string,
  action: Extract<AssistantAction, { type: "revise_rubric_check" }>,
  approvedBy?: string,
): Promise<string> {
  if (!approvedBy) throw new Error("A rubric change needs the person's approval.");
  const repo = repository();
  let fix = action.fix ? await repo.rubricFix(action.fix) : null;
  if (action.fix) {
    if (!fix || fix.projectId !== projectId) throw new Error("That rubric fix no longer exists.");
    if (fix.status !== "flagged" && fix.status !== "proposed") throw new Error("That rubric fix was already decided.");
  } else {
    const name = (action.sentinel ?? "").toLowerCase();
    const s = SENTINELS.find((x) => x.id.toLowerCase() === name || x.who.toLowerCase() === name);
    if (!s) throw new Error(`There is no Sentinel called ${action.sentinel}.`);
    fix = await repo.addRubricFix({
      projectId,
      sentinel: s.id,
      checkId: action.check!,
      problem: action.note!,
      suggestion: action.note!,
      flaggedBy: null,
      status: "proposed",
    });
  }
  const who = findSentinel(fix!.sentinel)?.who ?? fix!.sentinel;
  await repo.updateRubricFix(fix!.id, { status: "approved", approvedBy, approvedAt: new Date() });
  const started = await reviseRubricCheck(projectId, fix!.id);
  if (!started.ok) {
    await repo.updateRubricFix(fix!.id, { status: "failed", error: started.error });
    throw new Error(started.error);
  }
  return `${who} is revising check ${fix!.checkId}. Every other check stays as it is.`;
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
    return boardPorts().service.applyTransition(projectId, {
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

/** A ticket's pull request, merged as the person's "Merge it" would: red CI still does not merge. */
async function mergePullRequest(projectId: string, key: string): Promise<string> {
  const card = await cardByKey(projectId, key);
  if (card.kind !== "ticket" || !card.prNumber) throw new Error(`${key} has no pull request to merge.`);
  if (card.status === "running" || card.workingSince) throw new Error(`An agent is still working on ${key}. Stop it first.`);
  const ticket = await repository().ticketDetail(card.id);
  if (!ticket) throw new Error(`${key} is not on the board.`);
  const said = await mergeByPerson(projectId, ticket, card.prNumber);
  if ((await repository().ticketDetail(card.id))?.status !== "merged") throw new Error(said);
  return said;
}

async function closeCard(projectId: string, key: string): Promise<string> {
  const repo = repository();
  const card = await cardByKey(projectId, key);
  if (card.kind === "epic") {
    const result = await boardPorts().service.archiveEpic(projectId, card.id);
    if (!result.ok) throw new Error(result.reason);
    return `Archived ${key} and its tickets.`;
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
  const taken = new Set([...existing.map((t) => t.key), ...(await archivedKeysFor(projectId, epic.id))]);
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
  // Finished, perhaps only because its last open tickets were just closed to
  // make way for these: new work reopens it. After the tickets exist, so the
  // sweep that completes Epics cannot see it open with nothing left to do.
  const reopened = epic.status === "merged";
  if (reopened) await reopenEpic(projectId, epic.id);
  await publish(projectId, { type: "card.created", cardId: epic.id, kind: "epic", epicId: epic.id });
  const keys = tickets.map((t) => keyFor.get(t.key)).join(", ");
  return `Added ${keys} to ${epicKey}${reopened ? `, and reopened it in ${COLUMN_LABELS.todo}` : ""}.`;
}

/** A finished Epic back in To Do, with its issue reopened by the sync. */
async function reopenEpic(projectId: string, epicId: string): Promise<void> {
  const repo = repository();
  const positions = await repo.columnPositions(projectId, "todo");
  await repo.move({
    cardId: epicId,
    kind: "epic",
    status: "ready",
    stalledIn: null,
    position: positionForIndex(positions, positions.length),
  });
  await publish(projectId, {
    type: "card.status",
    cardId: epicId,
    kind: "epic",
    status: "ready",
    stalledIn: null,
    stage: 3,
    blockedReason: null,
  });
}

/**
 * Whether a red check's failure is the code's: the ticket is blocked on a fix
 * it waits for, or a failing check's annotations name a file in the
 * repository. A lost runner or a network error names no file.
 */
async function failureIsInTheCode(
  client: ReturnType<typeof vcs>,
  branch: string,
  checks: Awaited<ReturnType<ReturnType<typeof vcs>["checksFor"]>>,
  blockedReason: string | null | undefined,
): Promise<boolean> {
  if (waitedOn(blockedReason)) return true;
  const red = checks.filter((c) => c.status === "completed" && c.conclusion === "failure");
  for (const check of red) {
    const log = await client.checkLog(check.id).catch(() => null);
    for (const { path } of log?.annotations ?? []) {
      if ((await client.readFile(path, branch).catch(() => null)) !== null) return true;
    }
  }
  return false;
}

/** Brings main into a blocked ticket's branch, so it can turn green. */
export async function updateBranch(projectId: string, key: string): Promise<string> {
  const card = await cardByKey(projectId, key);
  if (card.kind !== "ticket" || !card.prNumber) throw new Error(`${key} has no pull request to bring up to date.`);
  const ticket = await repository().ticketDetail(card.id);
  if (!ticket) throw new Error(`${key} is not on the board.`);
  return updateFromMain(projectId, ticket);
}

/** A ticket's red checks, run again: for a failure that is not the code's. */
export async function rerunCi(projectId: string, key: string): Promise<string> {
  const card = await cardByKey(projectId, key);
  if (card.kind !== "ticket" || !card.prNumber) throw new Error(`${key} has no pull request to run CI on.`);
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.repoToken);
  const pull = await client.pullRequest(card.prNumber);
  const checks = await client.checksFor(pull.headSha);
  // A re-run tests the same commit, so a failure in the code fails again.
  // Bringing main in is the step that can turn it green: do that instead.
  if (await failureIsInTheCode(client, pull.headBranch, checks, card.status === "blocked" ? card.blockedReason : null)) {
    return updateBranch(projectId, key);
  }
  const started = await rerunRedActions(client, pull.headBranch, checks);
  if (started === 0) {
    throw new Error(
      `${key} has no failed Actions check that can run again: it is green, still running, or already re-ran once and failed again.`,
    );
  }
  return `Re-running ${started === 1 ? "the failed check" : `${started} failed runs`} on ${key}'s pull request #${pull.number}.`;
}

/** A blocked card now waits on a pull request that fixes what blocked it: its reason says so, over the one it had. */
export async function waitOnPullRequest(projectId: string, key: string, prNumber: number): Promise<void> {
  const card = await cardByKey(projectId, key);
  if (card.kind !== "ticket" || card.status !== "blocked") throw new Error(`${key} is not blocked, so there is nothing for #${prNumber} to unblock.`);
  const detail = (card.blockedReason ?? "").split("\n");
  const rest = waitedOn(detail[0]) ? detail.slice(1) : detail;
  const reason = [waitingOnReason(`#${prNumber}`), ...rest].join("\n").trim();
  await repository().updateTicket(card.id, { blockedReason: reason });
  await publish(projectId, {
    type: "card.status",
    cardId: card.id,
    kind: "ticket",
    status: card.status,
    stalledIn: card.stalledIn,
    stage: card.stage,
    blockedReason: reason,
  });
}

/** The assistant's own change, as a pull request into the base branch. */
async function openPullRequest(
  projectId: string,
  action: Extract<AssistantAction, { type: "open_pull_request" }>,
): Promise<string> {
  const project = await projectFor(projectId);
  const creds = await credentialsForProject(project);
  const client = vcs(project.repoFullName, creds.repoToken);
  if (!(await client.branchHead(action.branch))) throw new Error(`${action.branch} is not on GitHub any more.`);
  const pull =
    (await client.findPullRequest(action.branch)) ??
    (await client.openPullRequest({
      headBranch: action.branch,
      baseBranch: project.baseBranch,
      title: action.title,
      body: `${action.body}\n\n_Opened from the board's assistant._`,
    }));
  if (action.unblocks) await waitOnPullRequest(projectId, action.unblocks, pull.number);
  return `Opened pull request #${pull.number}: ${pull.url}`;
}

/*
 * The PM's own actions: what it does without asking (PM chat plan, decision
 * 2), held to the branch rules below whatever it was told to do.
 */

/** Branches the PM may work on besides a ticket's own. */
export const PM_BRANCH_PREFIXES = ["formic-pm/", "formic-staging/", ASSISTANT_BRANCH_PREFIX] as const;

/** Whether a change touches the repository's workflows, which nothing the PM does may. */
export function touchesWorkflows(paths: string[]): boolean {
  return paths.some((p) => p.replace(/^\/+/, "").startsWith(".github/workflows/"));
}

/**
 * Why the PM may not use a branch, or null when it may: only a branch of the
 * board's own repository, never the base branch, and only its own
 * (`formic-pm/`, `formic-staging/`, `formic/chat-`) or one of the board's ticket branches.
 */
export function branchProblem(branch: string, rules: { baseBranch: string; ticketBranches: ReadonlySet<string> }): string | null {
  const name = branch.trim();
  if (!name || /[:\s~^?*[\\]|\.\.|^refs\/|^-|\/$/.test(name)) return `"${branch}" is not a branch name.`;
  if (name === rules.baseBranch) return `${name} is the base branch; nothing goes onto it except through a merged pull request.`;
  if (PM_BRANCH_PREFIXES.some((p) => name.startsWith(p)) || rules.ticketBranches.has(name)) return null;
  return `${name} is not a branch of this board: use formic-pm/ for your own change, or a ticket's branch.`;
}

/** The branches of the board's tickets. */
async function ticketBranches(projectId: string): Promise<Set<string>> {
  const repo = repository();
  const tickets = (await repo.boardCards(projectId)).filter((c) => c.kind === "ticket" && !c.archived);
  const details = await Promise.all(tickets.map((t) => repo.ticketDetail(t.id)));
  return new Set(details.flatMap((d) => (d?.branchName ? [d.branchName] : [])));
}

/** The board's repository, as the board's own credentials reach it. */
async function boardRepo(projectId: string) {
  const project = await projectFor(projectId);
  if (!project.repoFullName) throw new Error("This board has no repository.");
  const creds = await credentialsForProject(project);
  return { project, client: vcs(project.repoFullName, creds.repoToken) };
}

/**
 * A pull request for a change the PM made, into the base branch. The branch
 * must pass branchProblem, already be on the board's repository, and leave
 * the workflows alone. One already open for the branch is returned instead.
 */
export async function openPmPullRequest(
  projectId: string,
  input: { branch: string; title: string; body: string; unblocks?: string },
): Promise<string> {
  const { project, client } = await boardRepo(projectId);
  const branch = input.branch.trim();
  const problem = branchProblem(branch, { baseBranch: project.baseBranch, ticketBranches: await ticketBranches(projectId) });
  if (problem) throw new Error(problem);
  if (!(await client.branchHead(branch))) throw new Error(`${branch} is not on ${project.repoFullName}. Push it first.`);
  const diff = await client.compare(project.baseBranch, branch);
  if (diff.files.length === 0) throw new Error(`${branch} has nothing that ${project.baseBranch} does not.`);
  if (touchesWorkflows(diff.files)) {
    throw new Error("That branch changes .github/workflows/, which the PM may not. Say what to change and the person can do it.");
  }
  const pull =
    (await client.findPullRequest(branch)) ??
    (await client.openPullRequest({
      headBranch: branch,
      baseBranch: project.baseBranch,
      title: input.title,
      body: `${input.body}\n\n_Opened by the board's PM._`,
    }));
  if (input.unblocks) await waitOnPullRequest(projectId, input.unblocks, pull.number);
  return `Opened pull request #${pull.number}: ${pull.url}`;
}

/**
 * Brings the base branch into a ticket's pull request, as GitHub's "Update
 * branch" does: a merge commit on the ticket's branch, never a rewrite, and
 * never onto the base branch itself.
 */
export async function updateBranchFromBase(projectId: string, key: string): Promise<string> {
  const card = await cardByKey(projectId, key);
  if (card.kind !== "ticket" || !card.prNumber) throw new Error(`${key} has no pull request to bring up to date.`);
  if (card.status === "running" || card.workingSince) throw new Error(`An agent is working ${key}; it brings the base in itself.`);
  const { project, client } = await boardRepo(projectId);
  const pull = await client.pullRequest(card.prNumber);
  if (pull.merged || pull.state === "closed") throw new Error(`Pull request #${pull.number} is not open.`);
  const problem = branchProblem(pull.headBranch, { baseBranch: project.baseBranch, ticketBranches: await ticketBranches(projectId) });
  if (problem) throw new Error(problem);
  const update = await client.updateBranch(pull.number);
  if (!update.ok) {
    throw new Error(
      update.conflict
        ? `${key} conflicts with ${pull.baseBranch}; it needs the conflict resolved on ${pull.headBranch}.`
        : `GitHub would not update ${pull.headBranch}: ${update.reason}`,
    );
  }
  return update.updated
    ? `Brought ${pull.baseBranch} into ${key}'s pull request #${pull.number}. CI runs again on the new head.`
    : `${key}'s pull request #${pull.number} already has everything on ${pull.baseBranch}.`;
}

/** Passes an answer to the agent that asked on a card; `own` marks it as the PM's, not the person's. */
export async function answerCardQuestion(projectId: string, key: string, answer: string, own: boolean): Promise<string> {
  const card = await cardByKey(projectId, key);
  if (!isQuestion(card.blockedReason)) throw new Error(`${card.key} is not waiting on a question.`);
  await askCardChat(projectId, card.kind, card.id, own ? `${PM_ANSWER_PREFIX}${answer}` : answer);
  return `Passed on. ${card.key}'s agent has started again with the answer.`;
}

/**
 * Makes one ticket wait for another, on this board. Refused when it already
 * does, when the other has merged (there is nothing to wait for), or when it
 * would make a loop.
 */
export async function addDependency(projectId: string, key: string, dependsOn: string): Promise<string> {
  const cards = await repository().boardCards(projectId);
  const find = (k: string) => cards.find((c) => c.key.toLowerCase() === k.trim().toLowerCase() && !c.archived);
  const ticket = find(key);
  const before = find(dependsOn);
  if (!ticket || ticket.kind !== "ticket") throw new Error(`${key} is not a ticket on the board.`);
  if (!before || before.kind !== "ticket") throw new Error(`${dependsOn} is not a ticket on the board.`);
  if (ticket.id === before.id) throw new Error("A ticket cannot wait for itself.");
  if (ticket.dependsOn.includes(before.id)) return `${ticket.key} already waits for ${before.key}.`;
  if (before.status === "merged") throw new Error(`${before.key} has merged already; there is nothing to wait for.`);
  const tickets = cards.filter((c) => c.kind === "ticket" && !c.archived);
  const ids = new Set(tickets.map((t) => t.id));
  const keyOf = new Map(tickets.map((t) => [t.id, t.key]));
  const dag = validateDag(
    tickets.map((t) => ({
      key: t.key,
      dependsOn: [...t.dependsOn.filter((d) => ids.has(d)), ...(t.id === ticket.id ? [before.id] : [])].map((d) => keyOf.get(d)!),
      fileScope: [],
    })),
  );
  const cycle = dag.problems.find((p) => p.kind === "cycle");
  if (cycle) throw new Error(`That would make a loop:\n${describeProblems([cycle])}`);
  await repository().addDependencies([{ ticketId: ticket.id, dependsOnTicketId: before.id }]);
  await publish(projectId, {
    type: "card.status",
    cardId: ticket.id,
    kind: "ticket",
    status: ticket.status,
    stalledIn: ticket.stalledIn,
    stage: ticket.stage,
    blockedReason: ticket.blockedReason,
  });
  return `${ticket.key} now waits for ${before.key}.`;
}
