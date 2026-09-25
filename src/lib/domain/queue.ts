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
