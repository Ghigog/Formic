/**
 * Stacked pull requests.
 *
 * A ticket that depends on another used to wait for it to merge, so a chain
 * of three tickets took three full trips through review and CI, one after
 * the other. Stacked, it starts as soon as the one it builds on has an open
 * pull request: from that pull request's branch, with its own pull request
 * targeting that branch, so its diff is only its own layer. When the one
 * below merges, the one above is retargeted to the merge target and brought
 * up to date, and goes through the merge queue like any other.
 *
 * Only a single unmerged prerequisite can be stacked on: a branch has one
 * base, and a ticket waiting on two open pull requests would need both.
 *
 * Pure: the board service and the pipelines act on the answer.
 */

export interface Stackable {
  id: string;
  kind: "epic" | "ticket";
  status: string;
  prNumber: number | null;
  dependsOn: readonly string[];
  /** The Epic a ticket belongs to; an Epic's own id is its card id. */
  epicId?: string | null;
  /** Epics only: the ids of the Epics it waits for. */
  waitsFor?: readonly string[];
  childCount?: number;
  doneCount?: number;
}

export type Readiness<T extends Stackable> =
  /** Every prerequisite has merged: it starts from the merge target. */
  | { ready: true; onto: null }
  /** One has an open pull request, the rest merged: it starts from that one's branch. */
  | { ready: true; onto: T }
  | { ready: false; waitingOn: T[] };

/**
 * The Epics this Epic waits for that are not done yet. Done is merged, every
 * ticket merged, or no longer on the board.
 */
export function openWaits<T extends Stackable>(epic: Stackable | undefined, all: Iterable<T>): T[] {
  if (!epic?.waitsFor?.length) return [];
  const byId = new Map<string, T>();
  for (const c of all) if (c.kind === "epic") byId.set(c.id, c);
  const open: T[] = [];
  for (const id of epic.waitsFor) {
    const e = byId.get(id);
    if (!e || e.status === "merged") continue;
    if ((e.childCount ?? 0) > 0 && e.doneCount === e.childCount) continue;
    open.push(e);
  }
  return open;
}

/** Whether a ticket can start now, and from where. */
export function readiness<T extends Stackable>(card: Stackable, all: readonly T[]): Readiness<T> {
  const byId = new Map(all.map((c) => [c.id, c]));
  const epic = card.epicId ? byId.get(card.epicId) : undefined;
  if (card.kind === "ticket" && openWaits(epic, all).length > 0) return { ready: false, waitingOn: [] };
  const open: T[] = [];
  let missing = false;
  for (const id of card.dependsOn) {
    const dep = byId.get(id);
    if (!dep) missing = true;
    else if (dep.status !== "merged") open.push(dep);
  }
  if (!missing && open.length === 0) return { ready: true, onto: null };
  if (!missing && open.length === 1 && stackable(open[0]!)) return { ready: true, onto: open[0]! };
  return { ready: false, waitingOn: open };
}

/** A prerequisite another ticket can build on: in review, with its pull request open. */
export function stackable(card: Stackable): boolean {
  return card.kind === "ticket" && card.status === "review" && card.prNumber !== null;
}
