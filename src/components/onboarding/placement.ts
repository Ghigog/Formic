/**
 * Where the guide ant stands and where its speech bubble goes, worked out from
 * the boxes it is talking about. Pure geometry, in viewport pixels, so the
 * tour can re-run it on every resize and scroll.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which side of the lit boxes the ant stands on. */
export type Side = "below" | "above" | "left" | "right" | "inside";

export interface Spot {
  x: number;
  y: number;
  /** Degrees, 0 = head up. The way the ant faces once it has arrived. */
  face: number;
}

/** How far the ant stands from the edge of what it points at. */
export const ANT_GAP = 34;
/** The ant's half-size, so it never stands half off the screen. */
const ANT_MARGIN = 36;
const BUBBLE_GAP = 44;
const EDGE = 16;
export const BUBBLE_W = 360;
/** The narrowest a bubble gets to stay beside the ant. */
export const BUBBLE_MIN_W = 280;
export const BUBBLE_H = 250;
/** Below this width the bubble docks to the bottom of the screen. */
export const DOCK_BELOW = 640;

export function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A box grown by `pad` on every side: the hole dug around a target. */
export function padded(b: Box, pad: number): Box {
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Where the ant stands beside `boxes`, facing them, kept on screen. */
export function antSpot(boxes: Box[], side: Side, vw: number, vh: number): Spot {
  const u = union(boxes);
  const cx = u.x + u.w / 2;
  const cy = u.y + u.h / 2;
  let p: Spot;
  if (side === "left") p = { x: u.x - ANT_GAP, y: cy, face: 90 };
  else if (side === "right") p = { x: u.x + u.w + ANT_GAP, y: cy, face: -90 };
  else if (side === "above") p = { x: cx, y: u.y - ANT_GAP, face: 180 };
  else if (side === "inside") p = { x: cx, y: u.y + u.h - 90, face: 0 };
  else p = { x: cx, y: u.y + u.h + ANT_GAP, face: 0 };
  return {
    ...p,
    x: clamp(p.x, ANT_MARGIN, vw - ANT_MARGIN),
    y: clamp(p.y, ANT_MARGIN, vh - ANT_MARGIN),
  };
}

/** The turn from `prev` to `target` the short way round, so the ant never spins. */
export function nearestAngle(prev: number, target: number): number {
  let t = target;
  while (t - prev > 180) t -= 360;
  while (t - prev < -180) t += 360;
  return t;
}

/** The heading, in degrees with 0 = up, from one point to another. */
export function heading(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
}

/** Seconds to walk between two points: quick for short hops, never a slog. */
export function walkSeconds(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return d < 4 ? 0 : clamp(d / 400, 0.5, 2.6);
}

export type Tail = "left" | "right" | "top" | "none";

export interface BubblePlace {
  x: number;
  y: number;
  w: number;
  /** Which edge of the bubble its tail sticks out of, towards the ant. */
  tail: Tail;
  /** The tail's offset along that edge. */
  tailAt: number;
  /** Docked to the bottom of a narrow screen. */
  docked: boolean;
}

/**
 * The bubble goes on the side away from what the ant points at, so it never
 * covers the lit part; under the ant for things along the top of the screen.
 */
export function bubblePlace(ant: Spot, side: Side, vw: number, vh: number): BubblePlace {
  if (vw < DOCK_BELOW) {
    return { x: EDGE, y: vh - BUBBLE_H - EDGE, w: vw - EDGE * 2, tail: "none", tailAt: 0, docked: true };
  }
  let w = Math.min(BUBBLE_W, vw - EDGE * 2);
  let x: number;
  let y: number;
  let tail: Tail;
  if (side === "below") {
    x = ant.x - w / 2;
    y = ant.y + 40;
    tail = "top";
    if (y + BUBBLE_H > vh - EDGE) {
      // No room under the ant: beside it instead.
      tail = ant.x > vw / 2 ? "right" : "left";
      x = tail === "right" ? ant.x - BUBBLE_GAP - w : ant.x + BUBBLE_GAP;
      y = ant.y - 52;
    }
  } else {
    // Room beside the ant on each side. A bubble narrows to fit its side
    // before it gives up and covers what the ant is pointing at.
    const room = (left: boolean) => (left ? ant.x - BUBBLE_GAP - EDGE : vw - EDGE - ant.x - BUBBLE_GAP);
    let toLeft = side === "left" ? true : side === "right" ? false : ant.x > vw / 2;
    if (room(toLeft) < BUBBLE_MIN_W && room(!toLeft) > room(toLeft)) toLeft = !toLeft;
    w = Math.max(BUBBLE_MIN_W, Math.min(w, room(toLeft)));
    x = toLeft ? ant.x - BUBBLE_GAP - w : ant.x + BUBBLE_GAP;
    tail = toLeft ? "right" : "left";
    y = ant.y - 52;
  }
  x = clamp(x, EDGE, vw - w - EDGE);
  y = clamp(y, EDGE, vh - BUBBLE_H - EDGE);
  const tailAt =
    tail === "top" ? clamp(ant.x - x - 6, 18, w - 30) : clamp(ant.y - y - 6, 18, BUBBLE_H - 40);
  return { x, y, w, tail, tailAt, docked: false };
}
