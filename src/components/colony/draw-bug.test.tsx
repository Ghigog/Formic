import { describe, expect, it } from "vitest";
import type { BugShape } from "@/lib/colony/game";
import { drawBug } from "./fx";

const SHAPES: BugShape[] = [
  "ant", "beetle", "ladybird", "caterpillar", "spider", "moth", "bumblebee", "stag", "mosquito",
];

/** A 2D context that records which drawing calls were made and ignores the rest. */
function recordingContext() {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, name: string) => (...args: unknown[]) => {
        void args;
        calls.push(name);
        return { addColorStop() {} };
      },
      set: () => true,
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("drawBug", () => {
  it.each(SHAPES)("draws a %s inside one save/restore pair", (shape) => {
    const { ctx, calls } = recordingContext();
    drawBug(ctx, 10, 10, 2, 0.3, shape, "#884422");
    expect(calls[0]).toBe("save");
    expect(calls.at(-1)).toBe("restore");
    expect(calls.length).toBeGreaterThan(4);
  });

  it.each(SHAPES)("draws a walking %s, turned and in step", (shape) => {
    const { ctx, calls } = recordingContext();
    drawBug(ctx, 0, 0, 1, 1.7, shape, "#448822", undefined, { rotate: 1, legSwing: 0.5, phase: 2 });
    expect(calls).toContain("rotate");
  });
});
