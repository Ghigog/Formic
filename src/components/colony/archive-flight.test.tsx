import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRUMBLE_COLS, CRUMBLE_ROWS, flyToNest } from "./archive-flight";
import type { Ghost } from "./epic-flight";

const ghost = (): Ghost => ({
  node: document.createElement("div"),
  box: null,
  dx: 0,
  dy: 0,
  rect: new DOMRect(10, 20, 200, 90),
});

let animated = 0;
let seen = 0;

beforeEach(() => {
  animated = 0;
  seen = 0;
  HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement) {
    animated++;
    seen = Math.max(seen, document.body.querySelectorAll("div[style*='clip-path']").length);
    return { finished: Promise.resolve() } as unknown as Animation;
  });
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("flyToNest", () => {
  it("crumbles into a grid of fragments, buries them and cleans up", async () => {
    const order: string[] = [];
    await flyToNest(ghost(), null, {
      onCrumble: () => order.push("crumble"),
      onBury: () => order.push("bury"),
    });
    expect(order).toEqual(["crumble", "bury"]);
    expect(seen).toBe(CRUMBLE_COLS * CRUMBLE_ROWS);
    expect(animated).toBe(CRUMBLE_COLS * CRUMBLE_ROWS * 2);
    expect(document.body.children).toHaveLength(0);
  });

  it("with reduced motion only crumbles in sound: no nodes, no animation", async () => {
    const onCrumble = vi.fn();
    const onBury = vi.fn();
    await flyToNest(ghost(), null, { reduced: true, onCrumble, onBury });
    expect(onCrumble).toHaveBeenCalledOnce();
    expect(onBury).not.toHaveBeenCalled();
    expect(animated).toBe(0);
    expect(document.body.children).toHaveLength(0);
  });
});
