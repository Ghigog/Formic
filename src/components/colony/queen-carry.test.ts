import { describe, expect, it } from "vitest";
import { MAX_SWAY_DEG, QUEEN_TOUCH_OFFSET_Y, WIGGLE_AMPLITUDE, edgeScrollSpeed, legWiggle, nextSway, queenPoint } from "./queen-carry";

describe("edgeScrollSpeed", () => {
  it("is 0 away from the edges and outside the area", () => {
    expect(edgeScrollSpeed(300, 100, 700)).toBe(0);
    expect(edgeScrollSpeed(50, 100, 700)).toBe(0);
    expect(edgeScrollSpeed(750, 100, 700)).toBe(0);
  });
  it("scrolls up near the top and down near the bottom", () => {
    expect(edgeScrollSpeed(110, 100, 700)).toBeLessThan(0);
    expect(edgeScrollSpeed(690, 100, 700)).toBeGreaterThan(0);
  });
  it("is faster the closer to the edge", () => {
    expect(Math.abs(edgeScrollSpeed(101, 100, 700))).toBeGreaterThan(Math.abs(edgeScrollSpeed(160, 100, 700)));
    expect(edgeScrollSpeed(699, 100, 700)).toBeGreaterThan(edgeScrollSpeed(640, 100, 700));
  });
});

describe("nextSway", () => {
  it("swings opposite ways for left and right travel", () => {
    expect(nextSway(0, 5)).toBeLessThan(0);
    expect(nextSway(0, -5)).toBeGreaterThan(0);
  });
  it("never exceeds the clamp", () => {
    let a = 0;
    for (let i = 0; i < 100; i++) a = nextSway(a, 500);
    expect(Math.abs(a)).toBeLessThanOrEqual(MAX_SWAY_DEG);
  });
  it("eases back to rest when the pointer stops", () => {
    let a = -20;
    for (let i = 0; i < 60; i++) a = nextSway(a, 0);
    expect(Math.abs(a)).toBeLessThan(0.1);
  });
});

describe("queenPoint", () => {
  it("shifts a touch pointer down by the offset", () => {
    expect(queenPoint(100, 200, "touch")).toEqual({ x: 100, y: 200 + QUEEN_TOUCH_OFFSET_Y });
  });
  it("leaves mouse and pen unchanged", () => {
    expect(queenPoint(100, 200, "mouse")).toEqual({ x: 100, y: 200 });
    expect(queenPoint(100, 200, "pen")).toEqual({ x: 100, y: 200 });
  });
});

describe("legWiggle", () => {
  it("is non-zero at several times and stays within the amplitude", () => {
    for (const t of [30, 77, 130, 410, 1234, 5000.5]) {
      const w = legWiggle(t);
      expect(w).not.toBe(0);
      expect(Math.abs(w)).toBeLessThanOrEqual(WIGGLE_AMPLITUDE);
    }
  });
  it("swings both ways", () => {
    const samples = Array.from({ length: 40 }, (_, i) => legWiggle(i * 10));
    expect(Math.min(...samples)).toBeLessThan(0);
    expect(Math.max(...samples)).toBeGreaterThan(0);
  });
});
