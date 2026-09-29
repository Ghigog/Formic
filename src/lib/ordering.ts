/**
 * Fractional indexing for column order.
 *
 * A dense integer `position` would make every drag an N-row write, and those
 * writes race against agents moving cards at the same time. A fractional index
 * touches exactly one row: the card that moved.
 *
 * Precision is finite, so repeatedly inserting between the same two cards will
 * eventually exhaust a float. `needsRebalance` reports that, and the caller
 * renumbers the column.
 */

export const POSITION_STEP = 1000;

/** Smallest gap we will split before declaring the column needs a rebalance. */
const MIN_GAP = 1e-6;

export function positionBetween(
  before: number | null,
  after: number | null,
): number {
  if (before == null && after == null) return POSITION_STEP;
  if (before == null) return after! - POSITION_STEP;
  if (after == null) return before + POSITION_STEP;
  return (before + after) / 2;
}

/** Position for dropping at `index` within a column already sorted ascending. */
export function positionForIndex(
  positions: readonly number[],
  index: number,
): number {
  const before = index > 0 ? (positions[index - 1] ?? null) : null;
  const after = index < positions.length ? (positions[index] ?? null) : null;
  return positionBetween(before, after);
}

export function needsRebalance(positions: readonly number[]): boolean {
  for (let i = 1; i < positions.length; i++) {
    const gap = positions[i]! - positions[i - 1]!;
    if (!Number.isFinite(gap) || gap < MIN_GAP) return true;
  }
  return false;
}

/** Evenly spaced positions for a column that ran out of precision. */
export function rebalance(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * POSITION_STEP);
}

export function byPosition<T extends { position: number }>(a: T, b: T): number {
  return a.position - b.position;
}

/**
 * The Done column's default order: what finished last reads first.
 *
 * A card's completion instant is its `mergedAt` — set once, the first time it
 * reaches merged — and for epics, which have none, its `updatedAt`, bumped the
 * moment `completeEpic` marks them merged. ISO strings compare correctly
 * lexically, so no parsing. This is the board's fallback ordering, not a
 * chosen sort: a pure comparator with no knowledge of columns or settings, so
 * a future custom sort can compose with or sit in front of it.
 */
export function byCompletion<
  T extends { position: number; mergedAt?: string | null; updatedAt?: string },
>(a: T, b: T): number {
  const at = (c: T) => c.mergedAt ?? c.updatedAt ?? "";
  const byTime = at(a).localeCompare(at(b));
  return byTime !== 0 ? -byTime : byPosition(a, b);
}
