import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { repository } from "@/lib/db";
import { fixAttempts, wakeLimits } from "@/lib/domain/pm-wake";
import { admitWake, noteLanded } from "./wake-gate";

/** The PM's wake-up limits (docs/plans/pm-chat.md, safety rows 3 and 5). */

const PROJECT = "project_default";
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 10, 21, hour, minute));

const admit = (over: Partial<Parameters<typeof admitWake>[0]> = {}) =>
  admitWake({ projectId: PROJECT, cardId: "c1", cardKey: "E1-T1", head: "h1", kind: "stall", now: at(10), ...over });

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
});

describe("wakeLimits", () => {
  it("fills what was never set with the defaults", () => {
    expect(wakeLimits({ fixCap: null, perHour: 3, perDay: null })).toEqual({ fixCap: 2, perHour: 3, perDay: 20 });
  });
});

describe("fixAttempts", () => {
  const r = (kind: string, head: string) => ({ kind, head });

  it("counts looks on the current head", () => {
    expect(fixAttempts([r("stall", "h1"), r("question", "h1"), r("stall", "h1")], "h1")).toBe(2);
  });

  it("keeps counting across a commit the PM landed", () => {
    expect(fixAttempts([r("stall", "h1"), r("landed", "h2"), r("stall", "h2")], "h2")).toBe(2);
  });

  it("starts again once someone else moved the branch", () => {
    expect(fixAttempts([r("stall", "h1"), r("stall", "h1")], "h3")).toBe(0);
    expect(fixAttempts([r("stall", "h0"), r("stall", "h1"), r("landed", "h2"), r("stall", "h2")], "h2")).toBe(2);
  });
});

describe("admitWake", () => {
  it("lets the PM look at a stuck ticket twice per head, then leaves it to the person, said once", async () => {
    expect(await admit({ now: at(10, 0) })).toEqual({ ok: true });
    await noteLanded(PROJECT, "c1", "h2", at(10, 5));
    expect(await admit({ head: "h2", now: at(10, 10) })).toEqual({ ok: true });

    const held = await admit({ head: "h2", now: at(10, 20) });
    expect(held).toMatchObject({ ok: false, held: "fix-cap" });
    expect(held.ok || held.say).toContain("E1-T1");
    expect(await admit({ head: "h2", now: at(10, 30) })).toEqual({ ok: false, held: "fix-cap", say: null });

    // An agent pushed: the PM may look again.
    expect(await admit({ head: "h9", now: at(10, 40) })).toEqual({ ok: true });
  });

  it("never caps a question by fix attempts", async () => {
    await repository().setPmWakeLimits(PROJECT, { fixCap: 0 });
    expect(await admit({ kind: "question" })).toEqual({ ok: true });
    expect(await admit({ kind: "stall" })).toMatchObject({ ok: false, held: "fix-cap" });
  });

  it("holds wake-ups past the hourly limit, across tickets, until the hour has passed", async () => {
    await repository().setPmWakeLimits(PROJECT, { perHour: 2 });
    expect(await admit({ cardId: "a", now: at(10, 0) })).toEqual({ ok: true });
    expect(await admit({ cardId: "b", kind: "question", now: at(10, 10) })).toEqual({ ok: true });

    const held = await admit({ cardId: "c", now: at(10, 20) });
    expect(held).toMatchObject({ ok: false, held: "hourly" });
    expect(held.ok || held.say).toContain("2 times in the last hour");
    expect(await admit({ cardId: "d", now: at(10, 30) })).toEqual({ ok: false, held: "hourly", say: null });

    expect(await admit({ cardId: "c", now: at(11, 11) })).toEqual({ ok: true });
  });

  it("keeps a daily allowance that renews at midnight UTC", async () => {
    await repository().setPmWakeLimits(PROJECT, { perDay: 2, perHour: 60 });
    expect(await admit({ cardId: "a", now: at(1) })).toEqual({ ok: true });
    expect(await admit({ cardId: "b", now: at(5) })).toEqual({ ok: true });

    const held = await admit({ cardId: "c", now: at(9) });
    expect(held).toMatchObject({ ok: false, held: "daily" });
    expect(held.ok || held.say).toContain("today's 2 wake-ups");
    expect(await admit({ cardId: "d", now: at(23) })).toEqual({ ok: false, held: "daily", say: null });

    const tomorrow = new Date(Date.UTC(2026, 10, 22, 0, 30));
    expect(await admit({ cardId: "c", now: tomorrow })).toEqual({ ok: true });
  });

  it("a held wake-up is not counted against the limits", async () => {
    await repository().setPmWakeLimits(PROJECT, { perHour: 1 });
    await admit({ cardId: "a", now: at(10, 0) });
    await admit({ cardId: "b", now: at(10, 10) });
    await admit({ cardId: "b", now: at(10, 20) });
    const wakes = (await repository().pmWakes(PROJECT, {})).filter((w) => w.kind === "stall" || w.kind === "question");
    expect(wakes).toHaveLength(1);
  });
});
