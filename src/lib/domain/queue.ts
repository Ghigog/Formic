import { scopesOverlap } from "@/lib/domain/scope";
import type { TicketStatus } from "@/lib/domain/status";

/**
 * Two agents never write the same files at once. A ticket that would is
 * queued in In Progress instead, and starts once the one in its way stops.
 */

interface Scoped {
  id: string;
  status: TicketStatus;
  fileScope: readonly string[];
}

/**
 * The running card already writing some of these files, if there is one.
 *
 * Only running cards count. A card in review holds an open pull request, but
 * it is not editing a checkout, and treating it as a conflict would stall the
 * board for as long as CI takes, which is most of the time.
 */
export function runningConflict<T extends Scoped>(card: Scoped, all: readonly T[]): T | null {
  if (card.fileScope.length === 0) return null;
  return (
    all.find(
      (other) =>
        other.id !== card.id &&
        other.status === "running" &&
        other.fileScope.length > 0 &&
        scopesOverlap(card.fileScope, other.fileScope),
    ) ?? null
  );
}

/** A running ticket's claim on its files, from any board on the repository. */
export interface Claim {
  ticketId: string;
  key: string;
  projectId: string;
  ownerLogin: string | null;
  fileScope: readonly string[];
}

/**
 * The claim already holding some of these files, on any board on the
 * repository. Path reservations are per repository, not per board: two
 * people's boards on one repository write into the same files, and only one
 * of them may be doing it at a time.
 */
export function heldBy<T extends Claim>(card: { id: string; fileScope: readonly string[] }, claims: readonly T[]): T | null {
  if (card.fileScope.length === 0) return null;
  return (
    claims.find(
      (c) => c.ticketId !== card.id && c.fileScope.length > 0 && scopesOverlap(card.fileScope, c.fileScope),
    ) ?? null
  );
}

/** How a claim is named to the person on `projectId`'s board. */
export function claimLabel(claim: Claim, projectId: string): string {
  if (claim.projectId === projectId) return claim.key;
  return claim.ownerLogin ? `${claim.key} on @${claim.ownerLogin}'s board` : `${claim.key} on another board`;
}
