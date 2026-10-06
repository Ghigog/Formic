import "server-only";

import { hasDatabase, repository } from "@/lib/db";
import { launch, runProductAgent } from "@/lib/agents/pipeline";
import { recoverStaleAssistantAnswers, recoverStaleCardChats } from "@/lib/agents/recovery";
import { prdSchema } from "@/lib/domain/entities";
import { startQueued } from "./queue";

/**
 * A card that says an agent is on it must have one. Moving a card writes its
 * status first and starts the agent detached, and a detached start can be
 * lost (the function frozen or cut off before it ran). Nothing reports a start
 * that never happened, so the card would wait forever. This finds those cards
 * and starts their agent again, briefed with the ticket's notes as any run is.
 *
 * An Epic waits in To Do for its PRD, and the Product Agent that writes one is
 * started the same detached way, so it is swept the same way. Backlog is left
 * alone: an Epic there is parked, and the board does not wake parked work up.
 *
 * A card's chat answer is started the same way and can be lost the same way,
 * except that leaving it pending also locks the chat; `recoverStaleCardChats`
 * is that half of the sweep.
 *
 * The sweep also polls GitHub for issues a person labelled `formic: intake`.
 * That belongs here for the same reason everything else does: it is the one
 * hook that already ticks on every board that is being looked at. So does
 * pruning the board's own log, which is the one table here that only grows.
 */

/** Long enough for any start in flight to show up as a run or a job. */
export const IDLE_AFTER_MS = 2 * 60_000;
const SWEEP_EVERY_MS = 30_000;
const lastSwept = new Map<string, number>();

/**
 * How much of a board's own log stays. Run output is what a log is mostly
 * made of, and it is worth nothing once read: on the first real board, 94% of
 * the events were `run.log` and the log was 82% of the whole database.
 */
const KEEP_PRUNABLE_EVENTS = 20_000;

/** Pruning is housekeeping, not the sweep's business: hourly is plenty. */
const PRUNE_EVERY_MS = 60 * 60_000;
const lastPruned = new Map<string, number>();

/**
 * The board's idle sweep, called on every tick of its event stream and on
 * every read of the board: answers nothing is writing any more, and cards
 * left working with nothing working them.
 */
export async function sweepIdleCards(projectId: string): Promise<void> {
  // Not gated on the database: a chat answer is lost by a function being cut
  // off, which has nothing to do with where the board is stored.
  await recoverStaleCardChats(projectId);
  await recoverStaleAssistantAnswers(projectId);
  if (hasDatabase()) await restartIdleCards(projectId);
}

/**
 * Only on a real database. The demo board's working cards are painted that
 * way with no agent behind them, and an in-memory store lives in one process,
 * where a start is not lost between instances.
 */
export async function restartIdleCards(projectId: string, now = Date.now()): Promise<void> {
  if (now - (lastSwept.get(projectId) ?? 0) < SWEEP_EVERY_MS) return;
  lastSwept.set(projectId, now);

  // Queued tickets start when the one ahead stops; that start can be lost too.
  await startQueued(projectId);

  // A person labels a GitHub issue `formic: intake`; this poll is what finds
  // it. The webhook only reaches a deployed board, and GitHub cannot reach a
  // laptop at all (docs/local.md), so this is the local path's way in. Skipped
  // outright when the project has no GitHub token.
  const { importIssues } = await import("@/lib/issues/intake");
  await importIssues(projectId);

  const repo = repository();

  // The board's own log is the one table here that only grows, and it is
  // almost all run output that nothing reads back. The newest frames stay;
  // the rest goes, on the same slow clock as everything else in this sweep.
  if (now - (lastPruned.get(projectId) ?? 0) >= PRUNE_EVERY_MS) {
    lastPruned.set(projectId, now);
    await repo.pruneEvents(projectId, KEEP_PRUNABLE_EVENTS);
  }

  for (const card of await repo.boardCards(projectId)) {
    if (card.workingSince || card.needsHuman) continue;
    const updated = card.updatedAt ? Date.parse(card.updatedAt) : now;
    if (now - updated < IDLE_AFTER_MS) continue;

    // An Epic in To Do with no PRD is waiting there for one (see
    // applyTransition), so an agent should be writing it. One whose start was
    // lost has no run and no job behind it, and would wait forever.
    //
    // An Epic that already has its PRD is left alone: that one is waiting on
    // its Architect Agent, and a breakdown run again can only replace the
    // tickets it already made, so the way back from that one is the drawer's
    // Retry, not the sweep.
    if (card.kind === "epic") {
      if (card.status !== "waiting") continue;
      const epic = await repo.epicDetail(card.id);
      if (!epic || epic.runnerJob || prdSchema.safeParse(epic.prd).success) continue;
      if (!(await repo.claimDelivery(`idle:${card.id}:${card.updatedAt}`))) continue;
      launch(
        () => runProductAgent(projectId, card.id, epic.rawRequest || card.title),
        `product agent for ${card.key}, restarted`,
      );
      continue;
    }

    if (card.kind !== "ticket") continue;
    if (card.status !== "running" && !(card.status === "review" && card.prNumber)) continue;
    const ticket = await repo.ticketDetail(card.id);
    if (!ticket || ticket.runnerJob || ticket.status !== card.status) continue;
    // Once per idle spell across every instance: any write to the ticket,
    // which a started agent always makes, opens a new one.
    if (!(await repo.claimDelivery(`idle:${ticket.id}:${card.updatedAt}`))) continue;

    if (ticket.status === "running") {
      const { runCoderAgent } = await import("@/lib/coder/pipeline");
      launch(() => runCoderAgent(projectId, ticket.id), `coder agent for ${ticket.key}, restarted`);
    } else {
      const prNumber = ticket.prNumber!;
      launch(async () => {
        const { projectFor } = await import("@/lib/board/project");
        const { credentialsForProject } = await import("@/lib/auth/credentials");
        const { vcs } = await import("@/lib/vcs");
        const { reviewPullRequest } = await import("@/lib/review/pipeline");
        const project = await projectFor(projectId);
        const creds = await credentialsForProject(project);
        const pull = await vcs(project.repoFullName, creds.githubToken).pullRequest(prNumber);
        await reviewPullRequest(projectId, prNumber, pull.headSha);
      }, `review for ${ticket.key}, restarted`);
    }
  }
}

/** Test seam. */
export function resetIdleSweep(): void {
  lastSwept.clear();
  lastPruned.clear();
}
