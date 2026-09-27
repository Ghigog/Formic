import "server-only";

import { hasDatabase, repository } from "@/lib/db";
import { launch } from "@/lib/agents/pipeline";
import { startQueued } from "./queue";

/**
 * A card that says an agent is on it must have one. Moving a card writes its
 * status first and starts the agent detached, and a detached start can be
 * lost (the function frozen or cut off before it ran). Nothing reports a start
 * that never happened, so the card would wait forever. This finds those cards
 * and starts their agent again, briefed with the ticket's notes as any run is.
 */

/** Long enough for any start in flight to show up as a run or a job. */
export const IDLE_AFTER_MS = 2 * 60_000;
const SWEEP_EVERY_MS = 30_000;
const lastSwept = new Map<string, number>();

/**
 * Only on a real database. The demo board's working cards are painted that
 * way with no agent behind them, and an in-memory store lives in one process,
 * where a start is not lost between instances.
 */
export async function sweepIdleCards(projectId: string): Promise<void> {
  if (hasDatabase()) await restartIdleCards(projectId);
}

export async function restartIdleCards(projectId: string, now = Date.now()): Promise<void> {
  if (now - (lastSwept.get(projectId) ?? 0) < SWEEP_EVERY_MS) return;
  lastSwept.set(projectId, now);

  // Queued tickets start when the one ahead stops; that start can be lost too.
  await startQueued(projectId);

  const repo = repository();
  for (const card of await repo.boardCards(projectId)) {
    if (card.kind !== "ticket" || card.workingSince || card.needsHuman) continue;
    if (card.status !== "running" && !(card.status === "review" && card.prNumber)) continue;
    const updated = card.updatedAt ? Date.parse(card.updatedAt) : now;
    if (now - updated < IDLE_AFTER_MS) continue;

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
}
