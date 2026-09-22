import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_BUDGET,
  ZERO_SPEND,
  addSpend,
  checkBudget,
  estimateCostCents,
  taskBudgetTokens,
} from "./limits";

describe("checkBudget", () => {
  it("passes a fresh run", () => {
    const v = checkBudget(ZERO_SPEND, DEFAULT_RUN_BUDGET);
    expect(v.ok).toBe(true);
  });

  it("stops at the spend ceiling", () => {
    const v = checkBudget({ ...ZERO_SPEND, cents: 200 }, DEFAULT_RUN_BUDGET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.exceeded).toBe("cost");
  });

  it("stops at the time ceiling", () => {
    const v = checkBudget(
      { ...ZERO_SPEND, elapsedMs: 15 * 60 * 1000 },
      DEFAULT_RUN_BUDGET,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.exceeded).toBe("time");
  });

  it("stops at the retry ceiling", () => {
    const v = checkBudget({ ...ZERO_SPEND, attempts: 3 }, DEFAULT_RUN_BUDGET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.exceeded).toBe("attempts");
  });

  it("reports cost first when several ceilings are breached", () => {
    const v = checkBudget(
      { cents: 500, elapsedMs: 10 ** 9, attempts: 99 },
      DEFAULT_RUN_BUDGET,
    );
    if (!v.ok) expect(v.exceeded).toBe("cost");
  });

  it("reports remaining headroom while under the cap", () => {
    const v = checkBudget({ ...ZERO_SPEND, cents: 50 }, DEFAULT_RUN_BUDGET);
    if (v.ok) expect(v.remainingCents).toBe(150);
  });
});

describe("estimateCostCents", () => {
  it("prices an Opus 5 call", () => {
    // 1M in at $5.00 plus 1M out at $25.00 is $30.00.
    expect(estimateCostCents("claude-opus-5", 1_000_000, 1_000_000)).toBeCloseTo(
      3000,
      5,
    );
  });

  it("prices Sonnet 5 below Opus 5 for the same tokens", () => {
    const opus = estimateCostCents("claude-opus-5", 100_000, 20_000);
    const sonnet = estimateCostCents("claude-sonnet-5", 100_000, 20_000);
    expect(sonnet).toBeLessThan(opus);
  });

  it("returns zero for an unknown model rather than guessing", () => {
    expect(estimateCostCents("mock", 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("taskBudgetTokens", () => {
  it("never returns a value the API would reject", () => {
    expect(taskBudgetTokens({ ...DEFAULT_RUN_BUDGET, maxCents: 1 })).toBe(20_000);
  });

  it("scales with the ceiling", () => {
    const small = taskBudgetTokens({ ...DEFAULT_RUN_BUDGET, maxCents: 200 });
    const large = taskBudgetTokens({ ...DEFAULT_RUN_BUDGET, maxCents: 20_000 });
    expect(large).toBeGreaterThan(small);
  });
});

describe("addSpend", () => {
  it("accumulates partial updates", () => {
    const s = addSpend(addSpend(ZERO_SPEND, { cents: 10 }), { attempts: 1 });
    expect(s).toEqual({ cents: 10, elapsedMs: 0, attempts: 1 });
  });
});
