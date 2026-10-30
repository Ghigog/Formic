import { describe, expect, it } from "vitest";
import { atRest, cordFor, createSwingDetector, MAX_CORD_PX, MAX_TILT_DEG, stepSpring, SWING_PX, tiltFor } from "./bell-swing";

describe("swinging the cord", () => {
  it("rings on a full swing across and back, once per grab", () => {
    const d = createSwingDetector();
    d.start(100);
    expect(d.move(100 + SWING_PX)).toBeNull();
    expect(d.move(100 - SWING_PX)).toBe("swing");
    expect(d.move(100 + SWING_PX)).toBe("ring");
    expect(d.move(100 - SWING_PX)).toBe("swing");
  });

  it("never rings on a tap or a wobble smaller than a swing", () => {
    const d = createSwingDetector();
    d.start(100);
    for (const x of [104, 96, 108, 94, 110, 100]) expect(d.move(x)).toBeNull();
    expect(d.swings).toBe(0);
  });

  it("measures a swing from the far end of the last one, wherever the hand turned", () => {
    const d = createSwingDetector();
    d.start(0);
    d.move(30);
    d.move(60);
    expect(d.move(60 - SWING_PX + 1)).toBeNull();
    expect(d.move(60 - SWING_PX)).toBe("swing");
  });
});

describe("the cord and the bell", () => {
  it("follows the hand until it is taut, and only a little downward", () => {
    expect(cordFor(10, 0).x).toBeCloseTo(9.7, 0);
    expect(Math.abs(cordFor(500, 0).x)).toBeLessThanOrEqual(MAX_CORD_PX);
    expect(cordFor(0, 500).y).toBe(10);
    expect(cordFor(0, -50).y).toBe(0);
  });

  it("turns the lip toward the cord, never past its limit", () => {
    expect(tiltFor(10)).toBeLessThan(0);
    expect(tiltFor(-1000)).toBe(MAX_TILT_DEG);
  });

  it("swings past its rest, then settles there", () => {
    let s = { angle: 20, velocity: 0 };
    let crossed = false;
    for (let i = 0; i < 400; i++) {
      s = stepSpring(s, 0, 16);
      if (s.angle < 0) crossed = true;
    }
    expect(crossed).toBe(true);
    expect(atRest(s)).toBe(true);
  });
});
