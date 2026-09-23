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
