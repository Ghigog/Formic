import { describe, expect, it } from "vitest";
import { PROVIDERS, provider } from "./providers";

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

describe("provider entries", () => {
  it("suggests DeepSeek's live models and talks to its documented host", () => {
    const info = provider("deepseek")!;
    expect(info.suggestedModels).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(info.baseUrl).toBe("https://api.deepseek.com");
  });

  it("tells ClinePass users which key to paste and suggests the plan's own slugs", () => {
    const info = provider("clinepass")!;
    expect(info.note).toContain("Settings > API Keys");
    expect(info.note).toMatch(/expires in 60 minutes/);
    expect(info.note).toMatch(/401/);
    // The plan's slugs, not the gateway's catalog. The catalog's `vendor/model`
    // ids are the metered API: a plan holder has no balance for them, so asking
    // for one is a 402 on the run's first turn, and the plan's own slugs are not
    // in `/models` to be found there. Which is the whole reason they are
    // suggested by hand — see the comment in providers.ts.
    expect(info.suggestedModels).toEqual([
      "cline-pass/deepseek-v4.1-flash",
      "cline-pass/glm-5.3",
      "cline-pass/kimi-k3",
      "cline-pass/qwen3.7-max",
    ]);
  });

  it("leaves no provider with no suggestions and a note that repeats its label", () => {
    const blank = PROVIDERS.filter(
      (p) =>
        p.suggestedModels.length === 0 &&
        (words(p.note) === words(p.label) || words(p.note).startsWith(`${words(p.label)} models`)),
    );
    expect(blank.map((p) => p.id)).toEqual([]);
  });
});
