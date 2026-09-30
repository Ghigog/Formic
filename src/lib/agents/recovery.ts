import "server-only";

import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { columnFor } from "@/lib/domain/status";

/**
 * What happens to a run whose worker died.
 *
 * PROT-06 asks that killing the worker mid-run resumes or cleanly fails, and
 * never leaves an orphaned sandbox. Resuming is a durable-workflow feature
 * this MVP does not have, so this does the other one, explicitly: a run still
 * marked live long after any worker could have died holding it is failed,
 * its card is parked with a reason a human can act on, and its
 * sandbox is reclaimed by the TTL every sandbox is created with (see
 * DEFAULT_TTL_MS). No orphan outlives that ceiling whether or not this
 * process ever comes back.
 */

const REASON =
  "The worker restarted while this run was in flight. Nothing was pushed; move the card back to To Do to try again.";

/**
 * On serverless, a new instance starting says nothing about the others: a
 * run can be live in a sibling instance while this one boots. What is
 * certain is that no function outlives its max duration (300s on Vercel), so
 * only runs older than that, with margin, are treated as orphaned.
 */
export const ORPHAN_AFTER_MS = 10 * 60 * 1000;

export async function reconcileOrphanedRuns(now = new Date()): Promise<number> {
  const repo = repository();
  const orphans = await repo.unfinishedRuns(new Date(now.getTime() - ORPHAN_AFTER_MS));
  if (orphans.length === 0) return 0;

  const fallback = await repo.defaultProject();

  for (const run of orphans) {
    const card = run.ticketId ?? run.epicId;
    const projectId =
      (card ? await repo.projectOfCard(card) : null) ?? fallback.id;
    await repo.finishRun(run.id, {
      status: "failed",
      error: REASON,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    });
    await publish(projectId, {
      type: "run.finished",
      runId: run.id,
      status: "failed",
      error: REASON,
    });

    if (!run.ticketId) continue;

    const ticket = await repo.ticketDetail(run.ticketId);
    if (!ticket || ticket.status === "merged") continue;

    const stalledIn = columnFor(ticket.status, ticket.stalledIn);
    await repo.updateTicket(ticket.id, {
      status: "failed",
      stalledIn,
      blockedReason: REASON,
    });
    await publish(projectId, {
      type: "card.status",
      cardId: ticket.id,
      kind: "ticket",
      status: "failed",
      stalledIn,
      stage: ticket.stage,
      blockedReason: REASON,
    });
  }

  return orphans.length;
}

/**
 * How long a chat answer may sit pending before it is treated as lost. Past
 * every route's `maxDuration` (300s on Vercel) with the same margin
 * `ORPHAN_AFTER_MS` gives a run, so an answer still in flight is never failed
 * out from under itself.
 */
export const CHAT_ORPHAN_AFTER_MS = 10 * 60 * 1000;

const CHAT_REASON = "The agent stopped before it could answer. Ask it again.";

/** How often a board's stale chats are looked for. The board's tail ticks every 2s. */
const RECHECK_EVERY_MS = 30_000;
const lastRechecked = new Map<string, number>();

/**
 * A card's chat answer runs in the same function that took the question, and
 * nothing journals it. A function killed mid-answer — the platform's own
 * limit, a hung provider call, a start that never ran — leaves its message
 * pending for good, and that is not only a missing reply: `ask` refuses a card
 * with a pending message and the drawer disables Clear chat while one is
 * there, so the person cannot ask that agent anything else at all.
 *
 * The answer a chat answer now gets is bounded (see CHAT_ANSWER_BUDGET_MS in
 * card-chat.ts), so this is the backstop for the ones that stop without
 * saying so. A CLI agent's answer has a job behind it and is left to
 * `collectCliRuns`. What is left is an answer with nothing behind it, older
 * than any function could still be writing one: it is marked failed, so the
 * chat takes questions again, and the crew the board put on the card walks
 * home.
 */
export async function recoverStaleCardChats(projectId: string, now = new Date()): Promise<number> {
  if (now.getTime() - (lastRechecked.get(projectId) ?? 0) < RECHECK_EVERY_MS) return 0;
  lastRechecked.set(projectId, now.getTime());

  const repo = repository();
  const stale = await repo.orphanedCardChats(projectId, new Date(now.getTime() - CHAT_ORPHAN_AFTER_MS));
  for (const message of stale) {
    await repo.updateCardChatMessage(message.id, { content: CHAT_REASON, status: "failed" });
    await publish(projectId, {
      type: "card.chat",
      cardId: message.cardId,
      kind: message.cardKind,
      state: "idle",
    });
  }
  return stale.length;
}

const ASSISTANT_REASON = "The assistant stopped before it could answer. Ask it again.";

/**
 * The board assistant's answer is lost the same way a card chat's is, and
 * leaves the same lock: POST /api/assistant refuses a question while a message
 * is pending. One with a job behind it is a CLI agent's, left to
 * `collectCliRuns`.
 */
export async function recoverStaleAssistantAnswers(projectId: string, now = new Date()): Promise<number> {
  const repo = repository();
  const stale = await repo.orphanedAssistantAnswers(projectId, new Date(now.getTime() - CHAT_ORPHAN_AFTER_MS));
  for (const message of stale) {
    await repo.updateAssistantMessage(message.id, { content: ASSISTANT_REASON, status: "failed" });
    await publish(projectId, { type: "assistant.failed", messageId: message.id });
  }
  return stale.length;
}

/** Test seam, like resetIdleSweep in board/idle.ts. */
export function resetChatRecovery(): void {
  lastRechecked.clear();
}

