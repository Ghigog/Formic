import "server-only";

import { repository } from "@/lib/db";
import type { BoardCard } from "@/lib/domain/entities";
import type { Reservation } from "@/lib/db/repository";
import { publish } from "@/lib/events/bus";
import { heldBy } from "@/lib/domain/queue";
import { byPosition } from "@/lib/ordering";
import { LeaseBusy, repoKey, withLease } from "./lease";

/**
 * Starts every queued ticket whose files no running ticket is writing any
 * more, in the order they sit in In Progress, so a person orders the queue
 * by ordering the column. Each one started counts against the ones after it.
 *
 * Path reservations belong to the repository, not to one board: two people
 * on one repository each have a board, and their agents write the same files.
 * So a pass looks at every board on the repository, and one pass runs at a
 * time per repository across every server instance (./lease.ts): two status
 * changes landing together would otherwise both see the same files free and
 * start two agents on them.
 */
export async function startQueued(projectId: string): Promise<void> {
  const project = await repository().projectById(projectId);
  if (!project) return;
  await startQueuedOn(project.repoFullName).catch((e: unknown) => {
    // Another instance is already starting this repository's queue; what it
    // misses, the next run that stops or the idle sweep picks up.
    if (e instanceof LeaseBusy) return;
    console.error("[formic] starting queued tickets failed:", e);
  });
}

/** The lease every start on a repository's files is decided under. */
export function reservationLease(repoFullName: string): string {
  return `reserve:${repoKey(repoFullName)}`;
}

async function startQueuedOn(repoFullName: string): Promise<void> {
  const started = await withLease(reservationLease(repoFullName), () => claimQueued(repoFullName));

  // Announced and launched after the lease is let go: an agent's events go
  // through the bus, and the bus starts queue passes of its own.
  const { runCoderAgent } = await import("@/lib/coder/pipeline");
  const { launch } = await import("@/lib/agents/pipeline");
  for (const { projectId, card } of started) {
    await publish(projectId, {
      type: "card.status",
      cardId: card.id,
      kind: "ticket",
      status: "running",
      stalledIn: null,
      stage: card.stage,
      blockedReason: null,
    });
    launch(() => runCoderAgent(projectId, card.id), `coder agent for ${card.key}`);
  }
}

async function claimQueued(repoFullName: string): Promise<Array<{ projectId: string; card: BoardCard }>> {
  const repo = repository();
  const projects = await repo.projectsForRepo(repoFullName);
  const boards = await Promise.all(projects.map(async (p) => ({ projectId: p.id, cards: await repo.boardCards(p.id) })));
  if (!boards.some((b) => b.cards.some(isQueued))) return [];

  const claims: Reservation[] = await repo.reservations(repoFullName);
  const started: Array<{ projectId: string; card: BoardCard }> = [];
  for (const { projectId, cards } of boards) {
    for (const card of cards.filter(isQueued).sort(byPosition)) {
      if (heldBy(card, claims)) continue;
      // A ticket sent back from review keeps its count of reviews: waiting
      // its turn is not a fresh start (a person's move already reset it).
      await repo.updateTicket(card.id, { status: "running", ...(card.prNumber ? {} : { attempts: 0 }) });
      card.status = "running";
      claims.push({ ticketId: card.id, key: card.key, projectId, ownerLogin: null, fileScope: card.fileScope });
      started.push({ projectId, card });
    }
  }
  return started;
}

function isQueued(card: BoardCard): boolean {
  return card.kind === "ticket" && card.status === "queued";
}

/**
 * Decides, under the repository's reservation lease, whether a ticket a
 * person just moved into In Progress may start now or waits its turn, and
 * writes that decision before anyone else can decide against it.
 *
 * `write` is handed the answer and must persist it; it runs inside the
 * lease, so it must not publish (see ./lease.ts).
 */
export async function claimOrQueue(
  projectId: string,
  card: BoardCard,
  write: (status: "running" | "queued") => Promise<void>,
): Promise<{ status: "running" | "queued"; blocker: Reservation | null }> {
  const repo = repository();
  const project = await repo.projectById(projectId);
  if (!project) {
    await write("running");
    return { status: "running", blocker: null };
  }
  return withLease(reservationLease(project.repoFullName), async () => {
    const blocker = heldBy(card, await repo.reservations(project.repoFullName));
    const status = blocker ? "queued" : "running";
    await write(status);
    return { status, blocker };
  });
}

/** The running ticket, on any board on the repository, holding this card's files. */
export async function blockerOf(projectId: string, card: BoardCard): Promise<Reservation | null> {
  const repo = repository();
  const project = await repo.projectById(projectId);
  if (!project) return null;
  return heldBy(card, await repo.reservations(project.repoFullName));
}

/**
 * Adds files to a running ticket's claim when nothing else on the repository
 * holds them. `write` persists the wider scope, inside the lease. False when
 * another ticket holds some of them.
 */
export async function widenClaim(
  projectId: string,
  card: { id: string; fileScope: readonly string[] },
  write: () => Promise<void>,
): Promise<boolean> {
  const repo = repository();
  const project = await repo.projectById(projectId);
  if (!project) return false;
  return withLease(reservationLease(project.repoFullName), async () => {
    if (heldBy(card, await repo.reservations(project.repoFullName))) return false;
    await write();
    return true;
  });
}
