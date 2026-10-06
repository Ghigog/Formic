import { describe, expect, it } from "vitest";
import { PROVIDERS, provider } from "./providers";

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

describe("provider entries", () => {
  it("suggests DeepSeek's live models and talks to its documented host", () => {
    const info = provider("deepseek")!;
    expect(info.suggestedModels).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(info.baseUrl).toBe("https://api.deepseek.com");
  });

  it("tells ClinePass users where a durable key comes from and suggests real model ids", () => {
    const info = provider("clinepass")!;
    expect(info.note).toContain("Settings > API Keys");
    expect(info.note).toMatch(/expires in 60 minutes/);
    expect(info.note).toMatch(/401/);
    // Cline's ids are `vendor/model` and never `cline-pass/…`: the gateway
    // lists deepseek/…, z-ai/… , moonshotai/… and qwen/…, and a made-up
    // prefix both failed to de-duplicate against the live list and turned the
    // word "Cline" in the model box into a filter that hid every real model.
    expect(info.suggestedModels).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4-pro",
      "z-ai/glm-5.3",
      "moonshotai/kimi-k3",
      "qwen/qwen3.7-max",
    ]);
    expect(info.suggestedModels.some((m) => m.startsWith("cline-pass/"))).toBe(false);
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
