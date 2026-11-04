import { describe, expect, it } from "vitest";
import type { Meeting } from "@/lib/db/repository";
import { BEAT_MS, MAX_PLOPS, occurrenceKey, pitchOf, plopSchedule } from "./entrance";

const occ = (id: string, day: number, hour: number) => ({
  meeting: { id } as Meeting,
  at: new Date(2026, 5, day, hour),
});

describe("plopSchedule", () => {
  it("puts plops in time order, one even beat apart", () => {
    const plops = plopSchedule([occ("b", 2, 14), occ("a", 1, 9), occ("a", 2, 9)]);
    expect(plops.map((p) => p.key)).toEqual([occurrenceKey(occ("a", 1, 9)), occurrenceKey(occ("a", 2, 9)), occurrenceKey(occ("b", 2, 14))]);
    expect(plops.map((p) => p.delay)).toEqual([0, BEAT_MS, 2 * BEAT_MS]);
  });

  it("pitches morning above evening", () => {
    expect(pitchOf(new Date(2026, 5, 1, 8))).toBeGreaterThan(pitchOf(new Date(2026, 5, 1, 18)));
    expect(pitchOf(new Date(2026, 5, 1, 3))).toBe(1);
    expect(pitchOf(new Date(2026, 5, 1, 23))).toBe(0);
  });

  it("stops at the cap, keeping the earliest", () => {
    const many = Array.from({ length: 30 }, (_, i) => occ("m", 1 + (i % 10), 7 + Math.floor(i / 10)));
    const plops = plopSchedule(many);
    expect(plops).toHaveLength(MAX_PLOPS);
  });

  it("is empty without meetings", () => {
    expect(plopSchedule([])).toEqual([]);
  });
});
