import { describe, expect, it } from "vitest";
import { ATTEMPT_DEFAULTS, budgetFor, DEFAULT_TOKENS_PER_STORY_POINT, PATH_RAILS } from "./budget-for";

describe("budgetFor", () => {
  it("defaults to 10 minutes a point, clamped to the in-process rail, naming it", () => {
    const b = budgetFor(null, null, { storyPoints: 8 }, "in-process");
    expect(b.minutes).toEqual({
      value: 5,
      requested: 80,
      clamp: { rail: "in-process", limitMinutes: 5, enforcement: "hard-rail" },
    });
  });

  it("clamps a loop run to the job's 55 usable minutes and marks it the job's ceiling", () => {
    const b = budgetFor(null, null, { storyPoints: 8 }, "loop");
    expect(b.minutes.value).toBe(55);
    expect(b.minutes.clamp).toEqual({ rail: "loop", limitMinutes: 55, enforcement: "job" });
  });

  it("leaves a value under the rail unclamped", () => {
    const b = budgetFor(null, null, { storyPoints: 2 }, "loop");
    expect(b.minutes).toEqual({ value: 20, requested: 20, clamp: null });
    expect(b.minutes.clamp).toBeNull();
  });

  it("uses flat when the mode is flat", () => {
    const b = budgetFor({ minutes: { mode: "FLAT", flat: 30 } }, null, { storyPoints: 8 }, "loop");
    expect(b.minutes.value).toBe(30);
  });

  it("uses by-hand values per point, falling back to the default rate", () => {
    const s = { minutes: { mode: "PER_POINT_BY_HAND" as const, byHand: { 2: 15 } } };
    expect(budgetFor(s, null, { storyPoints: 2 }, "loop").minutes.value).toBe(15);
    expect(budgetFor(s, null, { storyPoints: 3 }, "loop").minutes.value).toBe(30);
  });

  it("lets a column override win over a per point rule", () => {
    const s = { minutes: { mode: "PER_POINT" as const, perPoint: 10 } };
    const b = budgetFor(s, { minutes: 12 }, { storyPoints: 8 }, "loop");
    expect(b.minutes.value).toBe(12);
  });

  it("clamps a column override too", () => {
    const b = budgetFor(null, { minutes: 500 }, { storyPoints: 1 }, "loop");
    expect(b.minutes.value).toBe(55);
  });

  it("is unbounded except for the rail, which it names, when off", () => {
    const b = budgetFor({ minutes: { mode: "OFF" } }, null, { storyPoints: 8 }, "loop");
    expect(b.minutes.value).toBe(55);
    expect(b.minutes.requested).toBeNull();
    expect(b.minutes.clamp?.rail).toBe("loop");
    const t = budgetFor({ tokens: { mode: "OFF" } }, null, { storyPoints: 8 }, "cli-job");
    expect(t.tokens.value).toBeNull();
  });

  it("keeps the job cap and sandbox TTL as rails", () => {
    expect(PATH_RAILS["job-cap"].minutes).toBe(360);
    expect(PATH_RAILS.sandbox.minutes).toBe(20);
    expect(budgetFor({ minutes: { mode: "FLAT", flat: 999 } }, null, {}, "job-cap").minutes.value).toBe(360);
  });

  it("scales tokens per point and derives cents from tokens", () => {
    const one = budgetFor(null, null, { storyPoints: 1 }, "loop");
    const two = budgetFor(null, null, { storyPoints: 2 }, "loop");
    expect(two.tokens.value).toBe(2 * one.tokens.value!);
    expect(two.maxCents).toBeGreaterThan(one.maxCents!);
  });

  it("defaults tokens to a real token count per point, not a money figure", () => {
    expect(DEFAULT_TOKENS_PER_STORY_POINT).toBe(250_000);
    expect(budgetFor(null, null, { storyPoints: 1 }, "loop").tokens.value).toBe(250_000);
    expect(budgetFor(null, null, {}, "loop").tokens.value).toBe(250_000); // no points counts as 1
  });

  it("keeps today's attempt defaults", () => {
    expect(ATTEMPT_DEFAULTS).toEqual({ review: 4, decomposition: 3, draft: 2, cliAnswer: 2 });
    expect(budgetFor(null, null, {}, "loop", "draft").attempts.value).toBe(2);
  });

  it("applies flat and column overrides to attempts", () => {
    expect(budgetFor({ attempts: { mode: "FLAT", flat: 6 } }, null, {}, "loop").attempts.value).toBe(6);
    expect(budgetFor(null, { attempts: 1 }, {}, "loop").attempts.value).toBe(1);
  });
});
