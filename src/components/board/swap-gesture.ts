import { ownsGesture } from "./swipe";
import type { SwapDirection } from "./swap-order";

/** Vertical travel, in px, before a gesture counts as a swap. */
export const SWAP_THRESHOLD = 60;

/** The most the board follows a gesture before it lets go: a hint of the earth, not a scroll. */
export const MAX_PULL = 96;

/**
 * Which swap a vertical travel asks for, if any. It must pass the threshold and
 * be mostly vertical. Travelling up swaps down, as scrolling a page would.
 */
export function swapDirection(dx: number, dy: number): SwapDirection | null {
  if (Math.abs(dy) < SWAP_THRESHOLD || Math.abs(dy) <= Math.abs(dx) * 2) return null;
  return dy < 0 ? "down" : "up";
}

/**
 * How far the board follows a gesture still in progress: with resistance, so
 * it feels like pushing into soil, and only once the travel is mostly vertical.
 */
export function pullFor(dx: number, dy: number): number {
  if (Math.abs(dy) <= Math.abs(dx)) return 0;
  const resisted = MAX_PULL * Math.tanh(dy / (MAX_PULL * 2.2));
  return Math.round(resisted);
}

interface Point {
  clientX: number;
  clientY: number;
}

export interface SwapGestureEvents {
  touchStart(e: { touches: ArrayLike<Point>; target: EventTarget | null }, boundary: Element): void;
  /** True while three fingers are swapping, so the caller can stop the page scrolling under them. */
  touchMove(e: { touches: ArrayLike<Point> }): boolean;
  touchEnd(e: { changedTouches: ArrayLike<Point> }): void;
  touchCancel(): void;
  pointerDown(e: Point & { button: number; target: EventTarget | null }, boundary: Element): void;
  pointerMove(e: Point): void;
  pointerUp(e: Point & { button: number }): void;
  /**
   * Cancels the context menu while a right-button drag is under way (macOS and
   * Linux open it on the press) and once one has swapped (Windows opens it on
   * the release). A right-click on Windows with no drag still opens it.
   */
  contextMenu(e: { preventDefault(): void }): void;
}

/** A press that belongs to what it lands on: typing, a link, text to select. */
function interactive(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, textarea, select, a[href], [contenteditable='true']");
}

/**
 * Turns three-finger vertical swipes and right-button drags into `onSwap`
 * requests, and reports the gesture's travel as it goes to `onPull` (null once
 * it lets go), so the board can follow the hand.
 */
export function createSwapGestures(
  onSwap: (direction: SwapDirection) => void,
  onPull: (pull: number | null) => void = () => {},
): SwapGestureEvents {
  let touch: Point | null = null;
  let drag: Point | null = null;
  let suppressMenu = false;
  const release = () => onPull(null);
  return {
    touchStart(e, boundary) {
      const first = e.touches[0];
      // Exactly three fingers: one finger is a column swipe or card drag.
      touch = first && e.touches.length === 3 && !ownsGesture(e.target, boundary) ? first : null;
    },
    touchMove(e) {
      if (!touch) return false;
      if (e.touches.length !== 3) {
        touch = null;
        release();
        return false;
      }
      const now = e.touches[0]!;
      onPull(pullFor(now.clientX - touch.clientX, now.clientY - touch.clientY));
      return true;
    },
    touchEnd(e) {
      const start = touch;
      const end = e.changedTouches[0];
      touch = null;
      if (!start || !end) return;
      release();
      const direction = swapDirection(end.clientX - start.clientX, end.clientY - start.clientY);
      if (direction) onSwap(direction);
    },
    touchCancel() {
      if (!touch) return;
      touch = null;
      release();
    },
    pointerDown(e, boundary) {
      suppressMenu = false;
      drag =
        e.button === 2 && !ownsGesture(e.target, boundary) && !interactive(e.target)
          ? { clientX: e.clientX, clientY: e.clientY }
          : null;
    },
    pointerMove(e) {
      if (!drag) return;
      onPull(pullFor(e.clientX - drag.clientX, e.clientY - drag.clientY));
    },
    pointerUp(e) {
      const start = drag;
      drag = null;
      if (!start || e.button !== 2) return;
      release();
      const direction = swapDirection(e.clientX - start.clientX, e.clientY - start.clientY);
      if (!direction) return;
      suppressMenu = true;
      onSwap(direction);
    },
    contextMenu(e) {
      if (drag) {
        e.preventDefault();
        return;
      }
      if (!suppressMenu) return;
      suppressMenu = false;
      e.preventDefault();
    },
  };
}
