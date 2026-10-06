import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ repository: () => ({}) }));

const { runTimeBudgetFromRow, runTimeBudgetToRow } = await import("./index");

describe("run time budget row mapping", () => {
  it("maps a default row to per-point-of-story with nothing else", () => {
    expect(
      runTimeBudgetFromRow({
        runTimeBudgetMode: "PER_STORY_POINT",
        runTimeBudgetFlatMinutes: null,
        runTimeBudgetPerPointMinutes: null,
        runTimeBudgetPerPointRate: null,
      }),
    ).toEqual({ mode: "PER_STORY_POINT", flatMinutes: null, perPointRate: null, perPointMinutes: null });
  });

  it("carries a stored per-point rate", () => {
    const s = runTimeBudgetFromRow({
      runTimeBudgetMode: "PER_STORY_POINT",
      runTimeBudgetFlatMinutes: null,
      runTimeBudgetPerPointMinutes: null,
      runTimeBudgetPerPointRate: 12,
    });
    expect(s.perPointRate).toBe(12);
  });

  it("maps per-point JSON to numeric keys", () => {
    const s = runTimeBudgetFromRow({
      runTimeBudgetMode: "PER_POINT",
      runTimeBudgetFlatMinutes: null,
      runTimeBudgetPerPointMinutes: { "1": 5, "5": 40 },
      runTimeBudgetPerPointRate: null,
    });
    expect(s.perPointMinutes).toEqual({ 1: 5, 5: 40 });
  });

  it("treats malformed stored JSON as none", () => {
    const s = runTimeBudgetFromRow({
      runTimeBudgetMode: "PER_POINT",
      runTimeBudgetFlatMinutes: null,
      runTimeBudgetPerPointMinutes: [1, 2],
      runTimeBudgetPerPointRate: null,
    });
    expect(s.perPointMinutes).toBeNull();
  });

  it("maps domain to columns, round-tripping per-point", () => {
    const row = runTimeBudgetToRow({ mode: "PER_POINT", perPointMinutes: { 2: 15 }, flatMinutes: 9 });
    expect(row).toEqual({
      runTimeBudgetMode: "PER_POINT",
      runTimeBudgetFlatMinutes: null,
      runTimeBudgetPerPointMinutes: { "2": 15 },
      runTimeBudgetPerPointRate: null,
    });
    expect(runTimeBudgetFromRow(row).perPointMinutes).toEqual({ 2: 15 });
  });

  it("keeps flat minutes only in flat mode", () => {
    expect(runTimeBudgetToRow({ mode: "FLAT_MINUTES", flatMinutes: 30 })).toEqual({
      runTimeBudgetMode: "FLAT_MINUTES",
      runTimeBudgetFlatMinutes: 30,
      runTimeBudgetPerPointMinutes: null,
      runTimeBudgetPerPointRate: null,
    });
  });

  it("keeps a per-point rate only in per-story-point mode", () => {
    expect(runTimeBudgetToRow({ mode: "PER_STORY_POINT", perPointRate: 12 }).runTimeBudgetPerPointRate).toBe(12);
    expect(runTimeBudgetToRow({ mode: "OFF", perPointRate: 12 }).runTimeBudgetPerPointRate).toBeNull();
    expect(runTimeBudgetToRow({ mode: "PER_STORY_POINT" }).runTimeBudgetPerPointRate).toBeNull();
  });
});
