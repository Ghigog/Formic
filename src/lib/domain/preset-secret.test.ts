import { describe, expect, it } from "vitest";
import { agentPresetInputSchema } from "./entities";
import { provider, secretNameFor } from "@/lib/llm/providers";

const base = { name: "cc", provider: "claude-code", prompt: "" };

describe("a CLI agent's secret name", () => {
  it("takes any name that starts with the CLI's own prefix", () => {
    for (const secretName of ["FORMIC_CLAUDE_CODE_TOKEN", "FORMIC_CLAUDE_CODE_TOKEN_WORK"]) {
      expect(agentPresetInputSchema.safeParse({ ...base, secretName }).success).toBe(true);
    }
  });

  it("refuses a name outside the prefix, so the repository's other secrets stay unreachable", () => {
    for (const secretName of ["DEPLOY_KEY", "FORMIC_CODEX_AUTH", "formic_claude_code_token", "FORMIC_CLAUDE_CODE_TOKEN WORK"]) {
      expect(agentPresetInputSchema.safeParse({ ...base, secretName }).success).toBe(false);
    }
  });

  it("is what the agent runs with, else the name it had before", () => {
    const info = provider("claude-code")!;
    expect(secretNameFor({ presetId: "p1", info, secretName: "FORMIC_CLAUDE_CODE_TOKEN" })).toBe(
      "FORMIC_CLAUDE_CODE_TOKEN",
    );
    expect(secretNameFor({ presetId: "p1", info, secretName: null })).toBe("FORMIC_CLAUDE_CODE_TOKEN_P1");
  });
});
