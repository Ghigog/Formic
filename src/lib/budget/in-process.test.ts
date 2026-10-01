import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ attempts: undefined as unknown }));
vi.mock("@/lib/user-settings", () => ({
  getLimitSettings: async () => (settings.attempts ? { attempts: settings.attempts } : {}),
  getRunTimeBudgetSettings: async () => null,
}));

import { ATTEMPT_DEFAULTS } from "./budget-for";
import { attemptsFor } from "./in-process";

describe("attemptsFor", () => {
  beforeEach(() => {
    settings.attempts = undefined;
  });

  it("is today's count for each kind by default", async () => {
    for (const kind of Object.keys(ATTEMPT_DEFAULTS) as Array<keyof typeof ATTEMPT_DEFAULTS>) {
      expect(await attemptsFor("owner", kind)).toBe(ATTEMPT_DEFAULTS[kind]);
      expect(await attemptsFor(null, kind)).toBe(ATTEMPT_DEFAULTS[kind]);
    }
  });

  it("follows the attempts axis when the person changes it", async () => {
    settings.attempts = { mode: "FLAT", flat: 2 };
    expect(await attemptsFor("owner", "decomposition")).toBe(2);
    expect(await attemptsFor("owner", "review")).toBe(2);
  });

  it("keeps today's count when the axis is Off", async () => {
    settings.attempts = { mode: "OFF" };
    expect(await attemptsFor("owner", "draft")).toBe(ATTEMPT_DEFAULTS.draft);
  });
});
