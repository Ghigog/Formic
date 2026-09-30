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
      }),
    ).toEqual({ mode: "PER_STORY_POINT", flatMinutes: null, perPointMinutes: null });
  });

  it("maps per-point JSON to numeric keys", () => {
    const s = runTimeBudgetFromRow({
      runTimeBudgetMode: "PER_POINT",
      runTimeBudgetFlatMinutes: null,
      runTimeBudgetPerPointMinutes: { "1": 5, "5": 40 },
    });
    expect(s.perPointMinutes).toEqual({ 1: 5, 5: 40 });
  });

  it("treats malformed stored JSON as none", () => {
    const s = runTimeBudgetFromRow({
      runTimeBudgetMode: "PER_POINT",
      runTimeBudgetFlatMinutes: null,
      runTimeBudgetPerPointMinutes: [1, 2],
    });
    expect(s.perPointMinutes).toBeNull();
  });

  it("maps domain to columns, round-tripping per-point", () => {
    const row = runTimeBudgetToRow({ mode: "PER_POINT", perPointMinutes: { 2: 15 }, flatMinutes: 9 });
    expect(row).toEqual({
      runTimeBudgetMode: "PER_POINT",
      runTimeBudgetFlatMinutes: null,
      runTimeBudgetPerPointMinutes: { "2": 15 },
    });
    expect(runTimeBudgetFromRow(row).perPointMinutes).toEqual({ 2: 15 });
  });

  it("keeps flat minutes only in flat mode", () => {
    expect(runTimeBudgetToRow({ mode: "FLAT_MINUTES", flatMinutes: 30 })).toEqual({
      runTimeBudgetMode: "FLAT_MINUTES",
      runTimeBudgetFlatMinutes: 30,
      runTimeBudgetPerPointMinutes: null,
    });
  });
});
