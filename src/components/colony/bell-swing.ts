/**
 * The bell's mechanics, apart from how it is drawn: when a swing of the cord
 * counts, and how the bell moves on its hook. Pure, so both are tested
 * without a browser.
 */

/** Horizontal travel of the cord, in px, from one extreme to the other, that counts as a swing. */
export const SWING_PX = 22;
/** Swings (changes of direction) that ring it: across and back, as you would swing a real one. */
export const SWINGS_TO_RING = 2;
/** How far the cord follows the hand before it is taut. */
export const MAX_CORD_PX = 34;
/** How far the bell tilts per px of cord, and at most. */
const DEG_PER_PX = 0.9;
export const MAX_TILT_DEG = 32;

export type SwingEvent = "swing" | "ring" | null;

/**
 * Counts swings of the cord. A swing is a change of direction after at least
 * SWING_PX of travel, so a tap or a nervous wobble is never one; the
 * SWINGS_TO_RING-th rings the bell, once per grab.
 */
export function createSwingDetector() {
  let anchor = 0;
  let dir = 0;
  let swings = 0;
  let rung = false;
  return {
    start(x: number) {
      anchor = x;
      dir = 0;
      swings = 0;
      rung = false;
    },
    move(x: number): SwingEvent {
      const travel = x - anchor;
      if (dir === 0) {
        if (Math.abs(travel) >= SWING_PX) {
          dir = Math.sign(travel);
          anchor = x;
        }
        return null;
      }
      if (Math.sign(travel) === dir || travel === 0) {
        // Still going the same way: the extreme moves with it.
        anchor = x;
        return null;
      }
      if (Math.abs(travel) < SWING_PX) return null;
      dir = -dir;
      anchor = x;
      swings++;
      if (swings >= SWINGS_TO_RING && !rung) {
        rung = true;
        return "ring";
      }
      return "swing";
    },
    get swings() {
      return swings;
    },
  };
}

/** Where the cord's end sits for a hand this far from where it grabbed: taut past MAX_CORD_PX. */
export function cordFor(dx: number, dy: number): { x: number; y: number } {
  const x = MAX_CORD_PX * Math.tanh(dx / MAX_CORD_PX);
  const y = Math.max(0, Math.min(10, dy * 0.3));
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/**
 * The tilt, in degrees, the cord's end asks of the bell: the cord hangs from
 * below the hook, so pulling it right swings the lip right and the bell turns
 * anticlockwise (negative, as SVG turns).
 */
export function tiltFor(cordX: number): number {
  return Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, -cordX * DEG_PER_PX));
}

export interface Spring {
  angle: number;
  velocity: number;
}

/**
 * One step of a damped spring toward `target`: the bell swings on its hook
 * with weight, overshoots a little and settles. Semi-implicit Euler, stable
 * at frame-sized steps.
 */
export function stepSpring(s: Spring, target: number, dtMs: number, stiffness = 140, damping = 7): Spring {
  const dt = Math.min(dtMs, 48) / 1000;
  const velocity = s.velocity + (-stiffness * (s.angle - target) - damping * s.velocity) * dt;
  return { angle: s.angle + velocity * dt, velocity };
}

/** Whether a spring has come to rest at `target`. */
export function atRest(s: Spring, target = 0): boolean {
  return Math.abs(s.angle - target) < 0.05 && Math.abs(s.velocity) < 0.05;
}
