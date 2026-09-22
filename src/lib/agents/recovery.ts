import "server-only";

import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { columnFor } from "@/lib/domain/status";

/**
 * What happens to a run whose worker died.
 *
 * PROT-06 asks that killing the worker mid-run resumes or cleanly fails, and
 * never leaves an orphaned sandbox. Resuming is a durable-workflow feature
 * this MVP does not have, so this does the other one, explicitly: every run
 * still marked live at startup belongs to a process that no longer exists, so
 * it is failed, its card is parked with a reason a human can act on, and its
 * sandbox is reclaimed by the TTL every sandbox is created with (see
 * DEFAULT_TTL_MS). No orphan outlives that ceiling whether or not this
 * process ever comes back.
 */

const REASON =
  "The worker restarted while this run was in flight. Nothing was pushed; move the card back to To Do to try again.";

export async function reconcileOrphanedRuns(): Promise<number> {
  const repo = repository();
  const orphans = await repo.unfinishedRuns();
  if (orphans.length === 0) return 0;

  const project = await repo.defaultProject();

  for (const run of orphans) {
    await repo.finishRun(run.id, {
      status: "failed",
      error: REASON,
      tokensIn: 0,
      tokensOut: 0,
      costCents: 0,
    });
    await publish(project.id, {
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
    await publish(project.id, {
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
