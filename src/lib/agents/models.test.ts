import { describe, expect, it } from "vitest";
import { FALLBACK_BETA, TASK_BUDGET_BETA, requestShape } from "./models";

describe("requestShape", () => {
  it("sends Opus 5 everything the pipelines use", () => {
    const shape = requestShape("claude-opus-5", { effort: "xhigh", taskBudgetTokens: 50_000 });
    expect(shape.thinking).toEqual({ type: "adaptive" });
    expect(shape.fallbacks).toBe("default");
    expect(shape.betas).toEqual([TASK_BUDGET_BETA, FALLBACK_BETA]);
    expect(shape.outputConfig).toEqual({
      effort: "xhigh",
      task_budget: { type: "tokens", total: 50_000 },
    });
  });

  it("sends Haiku 4.5 none of the features it would reject", () => {
    const shape = requestShape("claude-haiku-4-5", { effort: "xhigh", taskBudgetTokens: 50_000 });
    expect(shape).toEqual({ betas: [], outputConfig: {} });
  });

  it("keeps refusal fallbacks to the models that accept them", () => {
    expect(requestShape("claude-sonnet-5").fallbacks).toBeUndefined();
    expect(requestShape("claude-fable-5-1").fallbacks).toBe("default");
  });
});
