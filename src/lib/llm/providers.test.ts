import { describe, expect, it } from "vitest";
import { PROVIDERS, provider } from "./providers";

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

describe("provider entries", () => {
  it("suggests DeepSeek's live models and talks to its documented host", () => {
    const info = provider("deepseek")!;
    expect(info.suggestedModels).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(info.baseUrl).toBe("https://api.deepseek.com");
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
