import { describe, expect, it } from "vitest";
import { chooseEffort, reasoningFor, roleReasoning } from "./reasoning";
import { provider } from "@/lib/llm/providers";

const info = (levels: string[], max?: number) => ({
  id: "deepseek-flash",
  ...(max ? { maxOutputTokens: max } : {}),
  effort: { supportedLevels: levels },
});

describe("reasoning per role", () => {
  it("asks low with thinking explicit for the coder and reviewer", () => {
    for (const role of ["coder", "reviewer"] as const) {
      const r = roleReasoning(role, info(["low", "high", "max"]));
      expect(r.reasoningEffort).toBe("low");
      expect(r.thinking).toEqual({ type: "enabled" });
    }
  });

  it("sends only an advertised level", () => {
    expect(chooseEffort("low", info(["low", "high"]))).toBe("low");
    expect(chooseEffort("low", info(["high", "max"]))).toBe("high");
    expect(chooseEffort("low", info(["medium"]))).toBeUndefined();
  });

  it("turns thinking off, never sends none, when no level fits", () => {
    const r = roleReasoning("coder", info(["medium"]));
    expect(r.thinking).toEqual({ type: "disabled" });
    expect(r.reasoningEffort).toBeUndefined();
  });

  it("holds the ceiling to the model's output limit", () => {
    expect(roleReasoning("coder", info(["low"], 8_192)).maxTokens).toBe(8_192);
    expect(roleReasoning("coder").maxTokens).toBe(64_000);
    expect(roleReasoning("chat").maxTokens).toBe(8_000);
  });

  it("only applies to DeepSeek", () => {
    expect(reasoningFor(provider("openai")!, "coder")).toEqual({});
    expect(reasoningFor(provider("deepseek")!, "coder").reasoningEffort).toBe("low");
  });
});
