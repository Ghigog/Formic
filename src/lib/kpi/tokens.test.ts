import { describe, expect, it } from "vitest";
import { openStayTokens, tokensByStay, type TokenStay, type TokenWork } from "./tokens";

const stay = (column: string, enteredAt: string, exitedAt: string | null): TokenStay => ({ column, enteredAt, exitedAt });
const work = (at: string, tokensIn: number, tokensOut = 0, reported = true): TokenWork => ({ at, tokensIn, tokensOut, reported });

const entries = [
  stay("in_progress", "2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z"),
  stay("in_review", "2026-01-01T12:00:00Z", "2026-01-01T13:00:00Z"),
  stay("in_progress", "2026-01-01T13:00:00Z", "2026-01-01T14:00:00Z"),
  stay("in_review", "2026-01-01T14:00:00Z", null),
];

describe("tokensByStay", () => {
  it("counts an item at a boundary in the stay that begins there", () => {
    const rows = tokensByStay(entries, [work("2026-01-01T12:00:00Z", 5000)]);
    expect(rows.map((r) => r.tokensIn)).toEqual([0, 5000, 0, 0]);
  });

  it("keeps a run that began before a move with the column it began in", () => {
    const rows = tokensByStay(entries, [work("2026-01-01T11:59:59Z", 100000, 20000)]);
    expect(rows[0]).toMatchObject({ tokensIn: 100000, tokensOut: 20000 });
    expect(rows[1]).toMatchObject({ tokensIn: 0 });
  });

  it("gives each In Review stay of a rework loop its own tokens", () => {
    const rows = tokensByStay(entries, [work("2026-01-01T12:30:00Z", 1000), work("2026-01-01T14:30:00Z", 2000)]);
    expect(rows.filter((r) => r.column === "in_review").map((r) => r.tokensIn)).toEqual([1000, 2000]);
  });

  it("sends an item before the first stay to the first", () => {
    expect(tokensByStay(entries, [work("2025-12-31T00:00:00Z", 7)])[0]!.tokensIn).toBe(7);
  });

  it("flags a stay holding work that reported no tokens", () => {
    const rows = tokensByStay(entries, [work("2026-01-01T10:30:00Z", 0, 0, false), work("2026-01-01T12:30:00Z", 3)]);
    expect(rows.map((r) => r.unreported)).toEqual([true, false, false, false]);
  });

  it("returns no rows without stays", () => {
    expect(tokensByStay([], [work("2026-01-01T10:30:00Z", 1)])).toEqual([]);
    expect(openStayTokens([], [])).toBeNull();
  });
});

describe("openStayTokens", () => {
  it("is the last stay's tokens", () => {
    expect(openStayTokens(entries, [work("2026-01-01T10:30:00Z", 9), work("2026-01-01T15:00:00Z", 5000)])).toEqual({
      tokensIn: 5000,
      tokensOut: 0,
      unreported: false,
    });
  });
});
