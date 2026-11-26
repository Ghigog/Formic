import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentView } from "./board-agents";
import { repository } from "@/lib/db";
import type { AgentPreset } from "@/lib/domain/entities";

const DAY = 86_400_000;
const user = { id: "u1" } as never;

function stubPresets(presets: Partial<AgentPreset>[]) {
  vi.spyOn(repository(), "listPresets").mockResolvedValue(presets as AgentPreset[]);
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.restoreAllMocks();
});

describe("agentView allowanceUsed", () => {
  it("is set only for presets with an allowance, counted inside each window, one query per window", async () => {
    stubPresets([
      { id: "a", tokenAllowance: 100 },
      { id: "b", tokenAllowance: 100, tokenAllowanceWindowDays: 7 },
      { id: "c", tokenAllowance: 100 },
      { id: "none", tokenAllowance: null },
    ]);
    const spy = vi.spyOn(repository(), "agentTokensByPreset").mockImplementation(async (since): Promise<Record<string, { tokensIn: number; tokensOut: number }>> => {
      const days = Math.round((Date.now() - since!.getTime()) / DAY);
      return days === 7
        ? { b: { tokensIn: 1, tokensOut: 2 }, none: { tokensIn: 9, tokensOut: 9 } }
        : { a: { tokensIn: 10, tokensOut: 5 }, none: { tokensIn: 9, tokensOut: 9 } };
    });
    const { presets } = await agentView(null, user);
    const used = Object.fromEntries(presets.map((p) => [p.id, p.allowanceUsed]));
    expect(used).toEqual({ a: 15, b: 3, c: 0, none: undefined });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("asks for no usage when no agent has an allowance", async () => {
    stubPresets([{ id: "a", tokenAllowance: null }]);
    const spy = vi.spyOn(repository(), "agentTokensByPreset");
    await agentView(null, user);
    expect(spy).not.toHaveBeenCalled();
  });
});
