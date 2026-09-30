import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINUTES_PER_STORY_POINT,
  parsePerPointMinutes,
  resolveRunTimeBudget,
  serialisePerPointMinutes,
  validateRunTimeBudgetSettings,
} from "./index";

const perPoint = { 1: 5, 2: 15, 5: 40 };

describe("resolveRunTimeBudget", () => {
  it("defaults to 10 minutes per story point with no explicit setting", () => {
    expect(DEFAULT_MINUTES_PER_STORY_POINT).toBe(10);
    expect(resolveRunTimeBudget(null, 3)).toBe(30);
    expect(resolveRunTimeBudget(undefined, 3)).toBe(30);
  });

  it("applies no budget when off", () => {
    expect(resolveRunTimeBudget({ mode: "OFF" }, 3)).toBeNull();
  });

  it("uses the flat minutes for any ticket", () => {
    const s = { mode: "FLAT_MINUTES" as const, flatMinutes: 30 };
    expect(resolveRunTimeBudget(s, 1)).toBe(30);
    expect(resolveRunTimeBudget(s, 8)).toBe(30);
    expect(resolveRunTimeBudget(s, null)).toBe(30);
  });

  it("multiplies per story point", () => {
    expect(resolveRunTimeBudget({ mode: "PER_STORY_POINT" }, 5)).toBe(50);
  });

  it("uses the per-point value for the ticket's points", () => {
    const s = { mode: "PER_POINT" as const, perPointMinutes: perPoint };
    expect(resolveRunTimeBudget(s, 5)).toBe(40);
  });

  it("falls back to 10 minutes per story point when per-point has no entry", () => {
    const s = { mode: "PER_POINT" as const, perPointMinutes: perPoint };
    expect(resolveRunTimeBudget(s, 3)).toBe(30);
    expect(resolveRunTimeBudget({ mode: "PER_POINT" }, 2)).toBe(20);
  });

  it("treats missing or less-than-1 story points as 1 point", () => {
    const s = { mode: "PER_STORY_POINT" as const };
    expect(resolveRunTimeBudget(s, null)).toBe(10);
    expect(resolveRunTimeBudget(s, undefined)).toBe(10);
    expect(resolveRunTimeBudget(s, 0)).toBe(10);
    expect(resolveRunTimeBudget(s, -2)).toBe(10);
    const p = { mode: "PER_POINT" as const, perPointMinutes: perPoint };
    expect(resolveRunTimeBudget(p, null)).toBe(5);
  });
});

describe("per-point JSON", () => {
  it("round-trips", () => {
    expect(parsePerPointMinutes(serialisePerPointMinutes(perPoint))).toEqual(
      perPoint,
    );
  });

  it("returns null for missing, malformed or invalid JSON", () => {
    expect(parsePerPointMinutes(null)).toBeNull();
    expect(parsePerPointMinutes("")).toBeNull();
    expect(parsePerPointMinutes("{oops")).toBeNull();
    expect(parsePerPointMinutes("[1,2]")).toBeNull();
    expect(parsePerPointMinutes('{"0":5}')).toBeNull();
    expect(parsePerPointMinutes('{"1.5":5}')).toBeNull();
    expect(parsePerPointMinutes('{"1":0}')).toBeNull();
    expect(parsePerPointMinutes('{"1":"5"}')).toBeNull();
  });
});

describe("validateRunTimeBudgetSettings", () => {
  it("accepts valid settings", () => {
    expect(validateRunTimeBudgetSettings({ mode: "OFF" })).toEqual({});
    expect(
      validateRunTimeBudgetSettings({ mode: "FLAT_MINUTES", flatMinutes: 1 }),
    ).toEqual({});
    expect(
      validateRunTimeBudgetSettings({
        mode: "PER_POINT",
        perPointMinutes: perPoint,
      }),
    ).toEqual({});
  });

  it("rejects flat minutes below 1 or missing", () => {
    for (const flatMinutes of [0, -5, null, undefined, NaN]) {
      expect(
        validateRunTimeBudgetSettings({ mode: "FLAT_MINUTES", flatMinutes })
          .flatMinutes,
      ).toBeTruthy();
    }
  });

  it("rejects an empty per-point map", () => {
    expect(
      validateRunTimeBudgetSettings({ mode: "PER_POINT", perPointMinutes: {} })
        .perPointMinutes,
    ).toMatch(/at least one/);
  });

  it("rejects per-point keys that are not integers of at least 1", () => {
    for (const key of ["0", "-1", "1.5", "abc"]) {
      expect(
        validateRunTimeBudgetSettings({ mode: "PER_POINT" }, { [key]: 5 })
          .perPointMinutes,
      ).toMatch(/Story points/);
    }
  });

  it("rejects per-point values below 1", () => {
    for (const v of [0, -3, 1.5, "x"]) {
      expect(
        validateRunTimeBudgetSettings({ mode: "PER_POINT" }, { "1": v })
          .perPointMinutes,
      ).toMatch(/Minutes/);
    }
  });
});
