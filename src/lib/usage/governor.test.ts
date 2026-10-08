import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repository } from "@/lib/db";
import {
  HEAVY_AT,
  REQUEST_BUSY_MS,
  countRequest,
  dailyBudget,
  holdFunction,
  resetGovernorForTests,
  sweepInterval,
  standingOf,
  usageReport,
  usedShare,
  utcDay,
  verdict,
  windowBudget,
} from "./governor";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const zero = { requests: 0, busyMs: 0, cpuMs: 0 };

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  resetGovernorForTests();
  vi.stubEnv("FORMIC_USAGE_LIMITS", "on");
});

afterEach(() => vi.unstubAllEnvs());

describe("budgets", () => {
  it("budget 70% of Hobby over 30 days, and a tenth of that a day", () => {
    expect(windowBudget().requests).toBe(350_000);
    expect(windowBudget().busyMs).toBe(180 * 3_600_000 * 0.7);
    expect(windowBudget().cpuMs).toBe(4 * 3_600_000 * 0.7);
    expect(dailyBudget().requests).toBe(35_000);
  });

  it("take their share from FORMIC_USAGE_SHARE, ignoring nonsense", () => {
    vi.stubEnv("FORMIC_USAGE_SHARE", "0.5");
    expect(windowBudget().requests).toBe(250_000);
    vi.stubEnv("FORMIC_USAGE_SHARE", "3");
    expect(windowBudget().requests).toBe(350_000);
  });

  it("are judged by whichever metric is furthest along, today's or the window's", () => {
    const w = windowBudget();
    const d = dailyBudget();
    expect(usedShare({ today: zero, window: { ...zero, cpuMs: w.cpuMs / 2 } })).toBe(0.5);
    expect(usedShare({ today: { ...zero, requests: d.requests }, window: zero })).toBe(1);
  });

  it("stop heavy work near the line and everything at it", () => {
    expect(standingOf(HEAVY_AT - 0.01)).toBe("ok");
    expect(standingOf(HEAVY_AT)).toBe("heavy");
    expect(standingOf(1)).toBe("stopped");
  });
});

describe("verdict", () => {
  it("is always ok when the governor is off, and counts nothing", async () => {
    vi.stubEnv("FORMIC_USAGE_LIMITS", "off");
    countRequest();
    expect((await verdict(NOW)).standing).toBe("ok");
    expect(await usageReport(NOW)).toEqual({ enabled: false });
  });

  it("is on by default on Vercel only", async () => {
    vi.stubEnv("FORMIC_USAGE_LIMITS", "");
    vi.stubEnv("VERCEL", "");
    expect(await usageReport(NOW)).toEqual({ enabled: false });
    vi.stubEnv("VERCEL", "1");
    expect(await usageReport(NOW)).toMatchObject({ enabled: true });
  });

  it("writes what it counted, and refuses once today's budget is spent", async () => {
    countRequest();
    expect((await verdict(NOW)).standing).toBe("ok");
    const report = await usageReport(NOW);
    expect(report).toMatchObject({ today: { requests: 2, busyMs: REQUEST_BUSY_MS } });

    const d = dailyBudget();
    await repository().addPlatformUsage(utcDay(NOW), { ...zero, requests: d.requests * HEAVY_AT }, utcDay(NOW));
    expect((await verdict(NOW + 10_000)).standing).toBe("heavy");

    await repository().addPlatformUsage(utcDay(NOW), { ...zero, requests: d.requests }, utcDay(NOW));
    const v = await verdict(NOW + 20_000);
    expect(v.standing).toBe("stopped");
    // Retry at the next UTC day.
    expect(v.retryAfter).toBe(12 * 3600 - 20);
  });

  it("opens again on a new day while the window has room", async () => {
    await repository().addPlatformUsage(utcDay(NOW), { ...zero, requests: dailyBudget().requests }, utcDay(NOW));
    expect((await verdict(NOW)).standing).toBe("stopped");
    expect((await verdict(NOW + 24 * 3_600_000)).standing).toBe("ok");
  });

  it("stays shut on a new day when the 30-day window is spent", async () => {
    const w = windowBudget();
    await repository().addPlatformUsage(utcDay(NOW - 5 * 86_400_000), { ...zero, busyMs: w.busyMs }, "2000-01-01");
    expect((await verdict(NOW)).standing).toBe("stopped");
    // Thirty days later that day has left the window.
    expect((await verdict(NOW + 25 * 86_400_000)).standing).toBe("ok");
  });

  it("goes ahead when the count cannot be written", async () => {
    vi.spyOn(repository(), "addPlatformUsage").mockRejectedValueOnce(new Error("down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await verdict(NOW)).standing).toBe("ok");
  });
});

describe("holdFunction", () => {
  it("charges the time a function was held", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const release = holdFunction();
      vi.setSystemTime(NOW + 90_000);
      await release();
      await release();
      const report = await usageReport(NOW + 90_000);
      expect(report).toMatchObject({ today: { busyMs: 90_000 } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sweepInterval", () => {
  it("slows the board's background checks to every two minutes on a serverless host only", () => {
    vi.stubEnv("FORMIC_EVENTS", "poll");
    expect(sweepInterval(15_000)).toBe(120_000);
    expect(sweepInterval(300_000)).toBe(300_000);
    vi.stubEnv("FORMIC_EVENTS", "stream");
    expect(sweepInterval(15_000)).toBe(15_000);
  });
});
