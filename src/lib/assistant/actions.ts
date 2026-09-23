import "server-only";

import { z } from "zod";

import { applyTickets } from "@/lib/agents/pipeline";
import { draftTicketSchema } from "@/lib/agents/decomposition";
import type { DraftTicket } from "@/lib/agents/ports";
import { createBacklogItem } from "@/lib/board/service";
import { repository } from "@/lib/db";
import { validateDag } from "@/lib/domain/dag";
import { describeProblems } from "@/lib/domain/problems";
import { normalizeScope } from "@/lib/domain/scope";
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
    tickets: z.array(draftTicketSchema).min(1).max(12),
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
    const tickets = normalized(action.tickets);
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
    return { ok: true, action: { ...action, tickets } };
  }
  return { ok: true, action };
}

function normalized(tickets: DraftTicket[]): DraftTicket[] {
  return tickets.map((t) => ({ ...t, fileScope: normalizeScope(t.fileScope) }));
}

/** Makes an approved change. Returns what now exists, for the conversation. */
export async function applyAction(projectId: string, action: AssistantAction): Promise<string> {
  if (action.type === "create_backlog_item") {
    const card = await createBacklogItem(projectId, action.request);
    return `Added ${card.key} to Backlog. The Product Agent is writing its PRD.`;
  }

  const repo = repository();
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
      scope: action.tickets.map((t) => `${t.key}: ${t.title}`),
      outOfScope: [],
      technicalContext: [],
      userStories: [],
      successCriteria: action.tickets.flatMap((t) => t.acceptanceCriteria),
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
  await applyTickets(projectId, epic.id, action.tickets);
  return `Added ${epic.key} to To Do with ${action.tickets.length} ticket${action.tickets.length === 1 ? "" : "s"}.`;
}
