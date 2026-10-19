/** Window event: a Queen is picked up (`on: true`) or put down (`on: false`). */
export const QUEEN_CARRY_EVENT = "formic:queen-carry";

export type QueenCarryDetail = { on: boolean };

/** How close to an edge of the scroll area the pointer must be to scroll it. */
export const EDGE_ZONE = 72;
const MAX_SCROLL_SPEED = 14;
/** The sway is clamped to this many degrees either way. */
export const MAX_SWAY_DEG = 25;

/**
 * Pixels to scroll per frame for a pointer at `y` over an area spanning
 * `top`..`bottom`: negative scrolls up, positive down, zero outside the edge
 * zones. Speed grows linearly with how deep into the zone the pointer is.
 */
export function edgeScrollSpeed(y: number, top: number, bottom: number): number {
  if (y < top || y > bottom) return 0;
  const zone = Math.min(EDGE_ZONE, (bottom - top) / 2);
  if (zone <= 0) return 0;
  if (y < top + zone) return -MAX_SCROLL_SPEED * ((top + zone - y) / zone);
  if (y > bottom - zone) return MAX_SCROLL_SPEED * ((y - (bottom - zone)) / zone);
  return 0;
}

/**
 * One frame of the Queen's sway, in degrees. `vx` is horizontal pointer
 * velocity in px/frame. The sway eases towards a target proportional to the
 * velocity (clamped), so it settles back to 0 once the pointer stops. Moving
 * right gives a negative angle: the legs trail behind the travel.
 */
export function nextSway(current: number, vx: number): number {
  const target = Math.max(-MAX_SWAY_DEG, Math.min(MAX_SWAY_DEG, -vx * 2));
  return current + (target - current) * 0.2;
}
