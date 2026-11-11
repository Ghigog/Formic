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

/** Travel, in px, a two-finger gesture needs before it is told apart as a swipe or a pinch. */
const SLOP = 12;

/** What two fingers are doing: not clear yet, a parallel vertical swipe, or a pinch. */
export type TwoFingerTravel = "pending" | "swipe" | "pinch";

const midpoint = (a: Point, b: Point): Point => ({ clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 });
const gap = (a: Point, b: Point) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/**
 * Tells a two-finger swipe from a pinch. Travel is that of the fingers'
 * midpoint. A swipe moves both fingers the same way, mostly vertically, with
 * the distance between them staying roughly the same; a pinch changes that
 * distance by more than the shared travel.
 */
export function classifyTwoFingerTravel(start: readonly [Point, Point], now: readonly [Point, Point]): TwoFingerTravel {
  const a = midpoint(...start);
  const b = midpoint(...now);
  const dx = b.clientX - a.clientX;
  const dy = b.clientY - a.clientY;
  const spread = Math.abs(gap(...now) - gap(...start));
  if (spread >= SLOP && spread > Math.hypot(dx, dy)) return "pinch";
  if (Math.abs(dy) >= SLOP && Math.abs(dy) > Math.abs(dx) * 2 && spread <= Math.max(SLOP, Math.abs(dy) * 0.4)) return "swipe";
  return "pending";
}

export interface SwapGestureEvents {
  touchStart(e: { touches: ArrayLike<Point>; target: EventTarget | null }, boundary: Element): void;
  /** True while two fingers are swiping, so the caller can stop the page scrolling under them. */
  touchMove(e: { touches: ArrayLike<Point> }): boolean;
  touchEnd(): void;
  touchCancel(): void;
  pointerDown(e: Point & { button: number; target: EventTarget | null }, boundary: Element): void;
  /** `buttons` is the bitmask of buttons now held: a move without the right one means its release was missed. */
  pointerMove(e: Point & { buttons: number }): void;
  pointerUp(e: Point & { button: number }): void;
  /**
   * Gives up a right-button drag whose release can no longer be trusted: the
   * pointer left the window, the window lost focus, or the browser cancelled
   * the pointer. The board lets go and nothing swaps.
   */
  cancel(): void;
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

/** Where a right-button press asks to be dragged to, and whether the drag has got there. */
export interface SwapAim {
  x: number;
  y: number;
  armed: boolean;
  /** The aim comes from a finger swipe, not a right-button drag. */
  touch?: true;
}

/**
 * Turns two-finger vertical swipes and right-button drags into `onSwap`
 * requests, and reports the gesture's travel as it goes to `onPull` (null once
 * it lets go), so the board can follow the hand.
 */
export function createSwapGestures(
  onSwap: (direction: SwapDirection) => void,
  onPull: (pull: number | null) => void = () => {},
  onAim: (aim: SwapAim | null) => void = () => {},
): SwapGestureEvents {
  /** The two fingers' start, once down, and the midpoint of their latest move once swiping. */
  let touch: { start: readonly [Point, Point]; last: Point | null } | null = null;
  let drag: Point | null = null;
  let suppressMenu = false;
  const release = () => onPull(null);
  /** Lets go of a touch gesture without swapping; false, as touchMove returns it. */
  const stopTouch = () => {
    const swiping = touch?.last;
    touch = null;
    if (swiping) {
      release();
      onAim(null);
    }
    return false;
  };
  const cancel = () => {
    if (!drag) return;
    drag = null;
    release();
    onAim(null);
  };
  return {
    touchStart(e, boundary) {
      const [first, second] = [e.touches[0], e.touches[1]];
      // Exactly two fingers: one finger is a column swipe or card drag, three or more do nothing.
      touch = first && second && e.touches.length === 2 && !ownsGesture(e.target, boundary) ? { start: [first, second], last: null } : null;
    },
    touchMove(e) {
      if (!touch) return false;
      const [first, second] = [e.touches[0], e.touches[1]];
      const kind = first && second && e.touches.length === 2 ? classifyTwoFingerTravel(touch.start, [first, second]) : "pinch";
      if (kind === "pinch") return stopTouch();
      if (kind === "pending") return false;
      const from = midpoint(...touch.start);
      const now = midpoint(first!, second!);
      touch.last = now;
      const dx = now.clientX - from.clientX;
      const dy = now.clientY - from.clientY;
      // One threshold from where the fingers started, the way they are travelling.
      onAim({ x: from.clientX, y: from.clientY + (dy < 0 ? -SWAP_THRESHOLD : SWAP_THRESHOLD), armed: swapDirection(dx, dy) !== null, touch: true });
      onPull(pullFor(dx, dy));
      return true;
    },
    touchEnd() {
      const t = touch;
      touch = null;
      if (!t?.last) return;
      release();
      onAim(null);
      const from = midpoint(...t.start);
      const direction = swapDirection(t.last.clientX - from.clientX, t.last.clientY - from.clientY);
      if (direction) onSwap(direction);
    },
    touchCancel() {
      stopTouch();
    },
    pointerDown(e, boundary) {
      suppressMenu = false;
      drag =
        e.button === 2 && !ownsGesture(e.target, boundary) && !interactive(e.target)
          ? { clientX: e.clientX, clientY: e.clientY }
          : null;
      // Where releasing would swap down: one threshold of travel straight up.
      if (drag) onAim({ x: drag.clientX, y: drag.clientY - SWAP_THRESHOLD, armed: false });
    },
    pointerMove(e) {
      if (!drag) return;
      if ((e.buttons & 2) === 0) return cancel();
      const dx = e.clientX - drag.clientX;
      const dy = e.clientY - drag.clientY;
      onAim({ x: drag.clientX, y: drag.clientY - SWAP_THRESHOLD, armed: swapDirection(dx, dy) === "down" });
      onPull(pullFor(e.clientX - drag.clientX, e.clientY - drag.clientY));
    },
    pointerUp(e) {
      const start = drag;
      if (!start) return;
      if (e.button !== 2) return cancel();
      drag = null;
      release();
      onAim(null);
      const direction = swapDirection(e.clientX - start.clientX, e.clientY - start.clientY);
      if (!direction) return;
      suppressMenu = true;
      onSwap(direction);
    },
    cancel,
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
