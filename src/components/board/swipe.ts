import { COLUMNS, type ColumnId } from "@/lib/domain/status";

/** Horizontal travel, in px, before a gesture counts as a swipe. */
export const SWIPE_THRESHOLD = 50;

export type SwipeDirection = "next" | "previous";

/** The column a step away, clamped at both ends: Backlog and Done do not wrap. */
export function adjacentColumn(current: ColumnId, direction: SwipeDirection): ColumnId {
  const i = COLUMNS.indexOf(current) + (direction === "next" ? 1 : -1);
  return COLUMNS[Math.min(COLUMNS.length - 1, Math.max(0, i))]!;
}

/**
 * Which way a gesture moves the board, if it is a swipe at all. It must
 * travel past the threshold and mostly sideways, so a vertical scroll of the
 * card list with a little drift is left alone. Swiping left reveals the next
 * column.
 */
export function swipeDirection(dx: number, dy: number): SwipeDirection | null {
  if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy) * 2) return null;
  return dx < 0 ? "next" : "previous";
}

/** Whether a gesture starting on `target` belongs to something else: a dialog, drawer or sideways scroller. */
export function ownsGesture(target: EventTarget | null, boundary: Element): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== boundary; el = el.parentElement) {
    if (el.closest("[role='dialog']") === el) return true;
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}
