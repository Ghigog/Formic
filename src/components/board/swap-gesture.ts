import { ownsGesture } from "./swipe";
import type { SwapDirection } from "./swap-order";

/** Vertical travel, in px, before a gesture counts as a swap. */
export const SWAP_THRESHOLD = 60;

/**
 * Which swap a vertical travel asks for, if any. It must pass the threshold and
 * be mostly vertical. Travelling up swaps down, as scrolling a page would.
 */
export function swapDirection(dx: number, dy: number): SwapDirection | null {
  if (Math.abs(dy) < SWAP_THRESHOLD || Math.abs(dy) <= Math.abs(dx) * 2) return null;
  return dy < 0 ? "down" : "up";
}

interface Point {
  clientX: number;
  clientY: number;
}

export interface SwapGestureEvents {
  touchStart(e: { touches: ArrayLike<Point>; target: EventTarget | null }, boundary: Element): void;
  touchEnd(e: { changedTouches: ArrayLike<Point> }): void;
  pointerDown(e: Point & { button: number; target: EventTarget | null }, boundary: Element): void;
  pointerUp(e: Point & { button: number }): void;
  /** Cancels the context menu only when the right button just finished a swap drag. */
  contextMenu(e: { preventDefault(): void }): void;
}

/** Turns three-finger vertical swipes and right-button drags into `onSwap` requests. */
export function createSwapGestures(onSwap: (direction: SwapDirection) => void): SwapGestureEvents {
  let touch: Point | null = null;
  let drag: Point | null = null;
  let suppressMenu = false;
  return {
    touchStart(e, boundary) {
      const first = e.touches[0];
      // Exactly three fingers: one finger is a column swipe or card drag.
      touch = first && e.touches.length === 3 && !ownsGesture(e.target, boundary) ? first : null;
    },
    touchEnd(e) {
      const start = touch;
      const end = e.changedTouches[0];
      touch = null;
      if (!start || !end) return;
      const direction = swapDirection(end.clientX - start.clientX, end.clientY - start.clientY);
      if (direction) onSwap(direction);
    },
    pointerDown(e, boundary) {
      suppressMenu = false;
      drag =
        e.button === 2 && !ownsGesture(e.target, boundary) ? { clientX: e.clientX, clientY: e.clientY } : null;
    },
    pointerUp(e) {
      const start = drag;
      drag = null;
      if (!start || e.button !== 2) return;
      const direction = swapDirection(e.clientX - start.clientX, e.clientY - start.clientY);
      if (!direction) return;
      suppressMenu = true;
      onSwap(direction);
    },
    contextMenu(e) {
      if (!suppressMenu) return;
      suppressMenu = false;
      e.preventDefault();
    },
  };
}
