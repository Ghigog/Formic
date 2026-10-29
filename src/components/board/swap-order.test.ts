import { describe, expect, it } from "vitest";
import { startStreak } from "./swap-order";

describe("startStreak", () => {
  it("steps down then up, landing on B then A", () => {
    const s = startStreak(["A", "B", "C"], "A");
    expect(s.step("down")).toEqual({ kind: "board", target: "B" });
    expect(s.step("up")).toEqual({ kind: "board", target: "A" });
  });

  it("bounces at both ends without wrapping", () => {
    const s = startStreak(["A", "B"], "B");
    expect(s.step("down")).toEqual({ kind: "end" });
    s.step("up");
    expect(s.step("up")).toEqual({ kind: "end" });
  });

  it("keeps the order it was frozen with", () => {
    const order = ["A", "B", "C"];
    const s = startStreak(order, "A");
    order.splice(1, 1);
    expect(s.step("down")).toEqual({ kind: "board", target: "B" });
  });

  it("answers end once ended", () => {
    const s = startStreak(["A", "B"], "A");
    s.end();
    expect(s.active).toBe(false);
    expect(s.step("down")).toEqual({ kind: "end" });
  });
});
