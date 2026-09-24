import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_BUDGET,
  ZERO_SPEND,
  addSpend,
  checkBudget,
  estimateCostCents,
  priceForModel,
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

  it("prices an OpenAI model by family", () => {
    expect(estimateCostCents("gpt-4o", 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it("prices a Gemini model by family", () => {
    expect(estimateCostCents("gemini-2.5-flash", 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it("prices a DeepSeek model by family", () => {
    expect(estimateCostCents("deepseek-chat", 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it("prices a Groq model by family", () => {
    expect(estimateCostCents("llama-3.3-70b-versatile", 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it("prices an OpenRouter id by the vendor after the slash", () => {
    const direct = estimateCostCents("gpt-4o", 1_000_000, 1_000_000);
    const routed = estimateCostCents("openai/gpt-4o", 1_000_000, 1_000_000);
    expect(routed).toBe(direct);
  });

  it("prices a dated Claude id as its family, not as $0", () => {
    const dated = estimateCostCents("claude-sonnet-5-20260101", 1_000_000, 1_000_000);
    const family = estimateCostCents("claude-sonnet-5", 1_000_000, 1_000_000);
    expect(dated).toBe(family);
    expect(dated).toBeGreaterThan(0);
  });

  it("never returns zero for an unknown model: it charges a conservative default", () => {
    const cost = estimateCostCents("some-brand-new-model-nobody-has-priced-yet", 1_000_000, 1_000_000);
    expect(cost).toBeGreaterThan(0);
  });

  it("prices an unknown model at least as high as any known family, so the ceiling still trips", () => {
    const unknown = estimateCostCents("totally-unknown-model", 1_000_000, 1_000_000);
    const opus = estimateCostCents("claude-opus-5", 1_000_000, 1_000_000);
    const gpt4o = estimateCostCents("gpt-4o", 1_000_000, 1_000_000);
    expect(unknown).toBeGreaterThanOrEqual(opus);
    expect(unknown).toBeGreaterThanOrEqual(gpt4o);
  });
});

describe("priceForModel", () => {
  it("reports a known family for an exact id", () => {
    const p = priceForModel("claude-opus-5");
    expect(p.known).toBe(true);
    expect(p.family).toBe("claude-opus-5");
  });

  it("reports a known family for a dated id by prefix match", () => {
    const p = priceForModel("claude-sonnet-5-20260101");
    expect(p.known).toBe(true);
    expect(p.family).toBe("claude-sonnet-5");
  });

  it("reports unknown, with a conservative default price, for an unrecognised id", () => {
    const p = priceForModel("some-brand-new-model-nobody-has-priced-yet");
    expect(p.known).toBe(false);
    expect(p.price.in).toBeGreaterThan(0);
    expect(p.price.out).toBeGreaterThan(0);
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
