import { describe, expect, it } from "vitest";
import {
  ANT_GAP,
  BUBBLE_W,
  antSpot,
  bubblePlace,
  heading,
  nearestAngle,
  union,
  walkSeconds,
} from "./placement";

/** Where the guide ant stands and where its bubble goes. */

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("antSpot", () => {
  it("stands beside what it points at, facing it", () => {
    const b = [box(500, 300, 200, 100)];
    expect(antSpot(b, "below", 1440, 900)).toEqual({ x: 600, y: 400 + ANT_GAP, face: 0 });
    expect(antSpot(b, "above", 1440, 900)).toEqual({ x: 600, y: 300 - ANT_GAP, face: 180 });
    expect(antSpot(b, "left", 1440, 900)).toEqual({ x: 500 - ANT_GAP, y: 350, face: 90 });
    expect(antSpot(b, "right", 1440, 900)).toEqual({ x: 700 + ANT_GAP, y: 350, face: -90 });
  });

  it("stands under the middle of several boxes at once", () => {
    const heads = [box(24, 90, 200, 60), box(1200, 90, 200, 60)];
    expect(antSpot(heads, "below", 1440, 900).x).toBe(712);
  });

  it("never stands off the screen", () => {
    const corner = antSpot([box(1400, 10, 40, 40)], "below", 1440, 900);
    expect(corner.x).toBeLessThanOrEqual(1440 - 36);
    const bottom = antSpot([box(10, 860, 40, 40)], "below", 1440, 900);
    expect(bottom.y).toBeLessThanOrEqual(900 - 36);
  });
});

describe("turning and walking", () => {
  it("turns the short way round", () => {
    expect(nearestAngle(170, -170)).toBe(190);
    expect(nearestAngle(-170, 170)).toBe(-190);
    expect(nearestAngle(0, 90)).toBe(90);
  });

  it("measures headings with 0 as up", () => {
    expect(heading({ x: 0, y: 0 }, { x: 0, y: -10 })).toBeCloseTo(0);
    expect(heading({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90);
  });

  it("takes no time for no distance and at most a few seconds for a long one", () => {
    expect(walkSeconds({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(0);
    expect(walkSeconds({ x: 0, y: 0 }, { x: 40, y: 0 })).toBe(0.5);
    expect(walkSeconds({ x: 0, y: 0 }, { x: 5000, y: 0 })).toBe(2.6);
  });

  it("unions boxes", () => {
    expect(union([box(0, 0, 10, 10), box(20, 5, 10, 10)])).toEqual(box(0, 0, 30, 15));
  });
});

describe("bubblePlace", () => {
  it("goes under the ant for things along the top", () => {
    const p = bubblePlace({ x: 700, y: 100, face: 0 }, "below", 1440, 900);
    expect(p.tail).toBe("top");
    expect(p.y).toBeGreaterThan(100);
  });

  it("goes away from what the ant points at", () => {
    expect(bubblePlace({ x: 600, y: 400, face: 90 }, "left", 1440, 900).tail).toBe("right");
    expect(bubblePlace({ x: 600, y: 400, face: 90 }, "left", 1440, 900).x).toBeLessThan(600 - BUBBLE_W);
    expect(bubblePlace({ x: 900, y: 400, face: -90 }, "right", 1440, 900).tail).toBe("left");
  });

  it("narrows to stay beside the ant before giving up a side", () => {
    const p = bubblePlace({ x: 416, y: 140, face: 90 }, "left", 1440, 900);
    expect(p.tail).toBe("right");
    expect(p.x).toBe(16);
    expect(p.x + p.w).toBeLessThanOrEqual(416 - 44);
  });

  it("flips to the other side when there is no room", () => {
    const p = bubblePlace({ x: 100, y: 400, face: 90 }, "left", 1440, 900);
    expect(p.tail).toBe("left");
    expect(p.x).toBeGreaterThan(100);
  });

  it("docks to the bottom of a phone", () => {
    const p = bubblePlace({ x: 100, y: 100, face: 0 }, "below", 390, 844);
    expect(p).toMatchObject({ docked: true, tail: "none", x: 16, w: 358 });
  });
});
