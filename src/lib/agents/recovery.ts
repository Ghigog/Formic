import "server-only";

import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { columnFor } from "@/lib/domain/status";
import { STUCK_RUN } from "@/lib/domain/notice";
import { stuckLine } from "@/lib/notifications/classify";

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
 * A run live on a ticket that has pushed no commit (checkpoint) for this long
 * is stuck. The clock counts from the later of the run's start and its last
 * commit (`lastCommitAt`), so a long run that keeps committing is left alone.
 */
export const STUCK_AFTER_MS = 30 * 60 * 1000;

const NOTHING_REPORTED = "nothing it reported";

/**
 * The no-commit clock. A ticket whose live Coder or Reviewer run is past
 * STUCK_AFTER_MS gets its column's agent restarted the way a person's
 * "resume" does it, and the person is told. If it was already restarted once
 * (`stuckNote` is set) it is stopped and blocked instead. Returns how many
 * tickets it acted on.
 */
export async function handleStuckRuns(now = new Date()): Promise<number> {
  const repo = repository();
  let acted = 0;
  for (const { ticketId, projectId } of await repo.ticketsWithLiveRun()) {
    const ticket = await repo.ticketDetail(ticketId);
    if (!ticket || ticket.status === "merged" || !ticket.lastCommitAt) continue;
    if (now.getTime() - Date.parse(ticket.lastCommitAt) < STUCK_AFTER_MS) continue;

    const { lastStepOf } = await import("@/lib/runner/runner");
    const step = lastStepOf(ticket.id);
    const reviewing = ticket.status === "review";
    const agent = reviewing ? "Reviewer Agent" : "Coder Agent";

    if (ticket.stuckNote) {
      const { stopTicket } = await import("@/lib/runner/runner");
      const { stallTicket } = await import("@/lib/coder/pipeline");
      await stopTicket(projectId, ticket.id);
      const stopped = (await repo.ticketDetail(ticket.id)) ?? ticket;
      await stallTicket(
        projectId,
        stopped,
        [
          STUCK_RUN,
          `First run last: ${ticket.stuckNote}`,
          `Restarted run last: ${step ?? NOTHING_REPORTED}`,
        ].join("\n"),
        { blocked: true, stalledIn: reviewing ? "in_review" : "in_progress" },
      );
      acted++;
      continue;
    }

    await repo.updateTicket(ticket.id, { stuckNote: step ?? NOTHING_REPORTED });
    await repo.addCardChatMessage({
      projectId,
      cardKind: "ticket",
      cardId: ticket.id,
      role: "assistant",
      content: stuckLine(agent, step),
    });
    await publish(projectId, { type: "run.stuck", ticketId: ticket.id, agent, step });
    const card = await repo.cardById(ticket.id);
    if (card) {
      const { resume } = await import("./card-actions");
      await resume(projectId, card);
    }
    acted++;
  }
  return acted;
}

/** A run orphaned at ORPHAN_AFTER_MS is failed within 15 minutes of going live. */
const RECOVERY_TICK_MS = 5 * 60 * 1000;

let clock: ReturnType<typeof setInterval> | null = null;
let reconciling = false;

async function reconcileOnce(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    await handleStuckRuns();
    const reclaimed = await reconcileOrphanedRuns();
    if (reclaimed > 0) {
      console.info(`[formic] failed ${reclaimed} run(s) orphaned by a restart`);
    }
  } catch (e) {
    // A database that is not up yet must not stop the server from running.
    console.warn("[formic] orphan recovery skipped:", e);
  } finally {
    reconciling = false;
  }
}

/**
 * Orphans are looked for at boot and then every few minutes, so a run whose
 * worker died is failed even if this server never restarts. Started once per
 * process (src/instrumentation.ts); the boot reconcile is not awaited.
 */
export function startRecoveryClock(): void {
  if (clock) return;
  clock = setInterval(() => void reconcileOnce(), RECOVERY_TICK_MS);
  clock.unref?.();
  void reconcileOnce();
}

/** Test seam, like the bell's. */
export function stopRecoveryClock(): void {
  if (clock) clearInterval(clock);
  clock = null;
  reconciling = false;
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

