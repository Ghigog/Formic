import { describe, expect, it } from "vitest";
import { kpis } from "@/components/colony/kpi-fixture";
import { kpiHeadline } from "./headline";

const make = (
  window: "30d" | "all",
  done: number,
  prevDone: number | null,
  passRate: number | null = 0.8,
) => {
  const k = kpis(window, done);
  k.tiles.passRate = passRate;
  k.previous = prevDone === null ? null : { ...k.tiles, done: prevDone };
  return k;
};

describe("kpiHeadline", () => {
  it("compares with the month before", () => {
    expect(kpiHeadline(make("30d", 12, 9))).toBe(
      "12 tickets done this month, 3 more than last. Review let 8 in 10 through first time.",
    );
    expect(kpiHeadline(make("30d", 1, 4))).toContain(
      "1 ticket done this month, 3 fewer than last.",
    );
    expect(kpiHeadline(make("30d", 4, 4))).toContain("the same as last");
  });
  it("has no comparison for all time and skips a missing pass rate", () => {
    expect(kpiHeadline(make("all", 20, null, null))).toBe(
      "20 tickets done in all.",
    );
  });
  it("is kind and number-free when nothing is done", () => {
    expect(kpiHeadline(make("30d", 0, 3))).not.toMatch(/\d/);
  });
});
