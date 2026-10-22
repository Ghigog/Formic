import "server-only";

import { z } from "zod";

import { applyTickets } from "@/lib/agents/pipeline";
import { ticketSpecSchema, toDraftTicket } from "@/lib/agents/decomposition";
import { applyTransition, createBacklogItem, deleteEpic } from "@/lib/board/service";
import { repository } from "@/lib/db";
import { validateDag } from "@/lib/domain/dag";
import { describeProblems } from "@/lib/domain/problems";
import { COLUMN_LABELS, COLUMNS, columnOf, hasActiveRun } from "@/lib/domain/status";
import { publish } from "@/lib/events/bus";
import { positionForIndex } from "@/lib/ordering";

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
 */

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
