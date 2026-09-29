import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_BUDGET,
  ZERO_SPEND,
  addSpend,
  billingFor,
  checkBudget,
  estimateCostCents,
  priceForModel,
  pricingNote,
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
      { ...ZERO_SPEND, elapsedMs: DEFAULT_RUN_BUDGET.maxDurationMs },
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

  it("does not stop a flat-rate run on money: tokens cost nothing extra there", () => {
    const v = checkBudget({ ...ZERO_SPEND, cents: 9_999 }, DEFAULT_RUN_BUDGET, "flat");
    expect(v.ok).toBe(true);
  });

  it("does not stop an unpriced run on a guess at what it might cost", () => {
    const v = checkBudget({ ...ZERO_SPEND, cents: 9_999 }, DEFAULT_RUN_BUDGET, "unknown");
    expect(v.ok).toBe(true);
  });

  it("still stops a flat-rate run on time", () => {
    const v = checkBudget({ ...ZERO_SPEND, elapsedMs: 10 ** 9 }, DEFAULT_RUN_BUDGET, "flat");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.exceeded).toBe("time");
  });

  it("still stops an unpriced run on attempts", () => {
    const v = checkBudget({ ...ZERO_SPEND, attempts: 3 }, DEFAULT_RUN_BUDGET, "unknown");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.exceeded).toBe("attempts");
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

  it("prices the live DeepSeek ids at their real rates, not a guess", () => {
    // Flash: 1M in at $0.30 plus 1M out at $1.20 is $1.50.
    expect(estimateCostCents("deepseek-flash", 1_000_000, 1_000_000)).toBeCloseTo(150, 5);
    // V4-Pro: 1M in at $1.32 plus 1M out at $3.96 is $5.28.
    expect(estimateCostCents("deepseek-v4-pro", 1_000_000, 1_000_000)).toBeCloseTo(528, 5);
  });

  it("lands every id shape DeepSeek is served under on the right family", () => {
    const flash = estimateCostCents("deepseek-flash", 1_000_000, 0);
    expect(estimateCostCents("deepseek-v4-flash", 1_000_000, 0)).toBe(flash);
    expect(estimateCostCents("deepseek-v4-flash-vision-exp", 1_000_000, 0)).toBe(flash);
    expect(estimateCostCents("deepseek/deepseek-v4.1-flash", 1_000_000, 0)).toBe(flash);
    expect(estimateCostCents("deepseek-flash-0813", 1_000_000, 0)).toBe(flash);
    expect(estimateCostCents("deepseek-v4-pro", 1_000_000, 0)).toBeGreaterThan(flash);
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

  it("charges nothing for an id nobody has priced, rather than a rate that does not exist", () => {
    const cost = estimateCostCents("some-brand-new-model-nobody-has-priced-yet", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it("charges nothing per token on a flat-rate plan, whatever the id looks like", () => {
    const viaPlan = estimateCostCents("deepseek/deepseek-v4.1-flash", 1_000_000, 1_000_000, "clinepass");
    expect(viaPlan).toBe(0);
    // The same model on the provider that really bills per token is money:
    // the plan is what makes it free, not the id.
    const direct = estimateCostCents("deepseek-v4.1-flash", 1_000_000, 1_000_000, "deepseek");
    expect(direct).toBeGreaterThan(0);
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

  it("reports unknown, and charges nothing for it, when an id has no price", () => {
    const p = priceForModel("some-brand-new-model-nobody-has-priced-yet");
    expect(p.known).toBe(false);
    expect(p.billing).toBe("unknown");
    expect(p.price.in).toBe(0);
    expect(p.price.out).toBe(0);
  });
});

describe("billingFor", () => {
  it("calls a flat-rate provider flat, whatever model id it serves", () => {
    expect(billingFor("deepseek/deepseek-v4.1-flash", "clinepass")).toBe("flat");
    expect(billingFor("cline-pass/glm-5.3", "clinepass")).toBe("flat");
  });

  it("meters a priced model on a provider that bills per token", () => {
    expect(billingFor("deepseek-v4.1-flash", "deepseek")).toBe("metered");
  });

  it("is unknown when nothing has priced the id, or there is no model", () => {
    expect(billingFor("some-brand-new-model", "openrouter")).toBe("unknown");
    expect(billingFor(null, "openai")).toBe("unknown");
  });
});

describe("pricingNote", () => {
  it("tells someone on a flat-rate plan that time is the limit, not dollars", () => {
    expect(pricingNote("cline-pass/glm-5.3", "clinepass")).toContain("Flat-rate plan");
  });

  it("says an unpriced model is not counted against the ceiling", () => {
    expect(pricingNote("mystery-model", "openrouter")).toContain("No price known");
  });

  it("names the family a metered model is billed as", () => {
    expect(pricingNote("claude-opus-5", "anthropic")).toContain("claude-opus-5");
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
