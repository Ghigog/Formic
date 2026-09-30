import { describe, expect, it } from "vitest";
import { capMonth, fallbackSecondsLeft } from "./fallback-cap";

const now = new Date("2026-09-15T12:00:00Z");

describe("fallbackSecondsLeft", () => {
  it("subtracts this month's usage from the cap", () => {
    const user = { fallbackSandboxSeconds: 600, fallbackSandboxMonth: capMonth(now) };
    expect(fallbackSecondsLeft(user, 30, now)).toBe(1200);
  });

  it("is zero once the cap is reached, never negative", () => {
    const user = { fallbackSandboxSeconds: 2000, fallbackSandboxMonth: capMonth(now) };
    expect(fallbackSecondsLeft(user, 30, now)).toBe(0);
  });

  it("ignores usage from an earlier month", () => {
    const user = { fallbackSandboxSeconds: 2000, fallbackSandboxMonth: "2026-08" };
    expect(fallbackSecondsLeft(user, 30, now)).toBe(1800);
  });
});
