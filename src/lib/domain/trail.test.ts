import { describe, expect, it } from "vitest";
import { FAINT, NOTE_HALF_LIFE_MS, RATING_HALF_LIFE_MS, strengthOf, strongest, type TrailRating } from "./trail";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16);

function note(seq: number, daysAgo: number) {
  return { seq, at: new Date(NOW - daysAgo * DAY) };
}

function rating(noteSeq: number, ticketId: string, verdict: TrailRating["verdict"], daysAgo: number): TrailRating {
  return { noteSeq, ticketId, verdict, at: new Date(NOW - daysAgo * DAY) };
}

describe("strengthOf", () => {
  it("starts at 1 and halves every half-life", () => {
    expect(strengthOf(note(1, 0), [], NOW)).toBe(1);
    expect(strengthOf(note(1, NOTE_HALF_LIFE_MS / DAY), [], NOW)).toBeCloseTo(0.5);
  });

  it("an unrated note goes faint in about three days", () => {
    expect(strengthOf(note(1, 3), [], NOW)).toBeGreaterThan(FAINT);
    expect(strengthOf(note(1, 4), [], NOW)).toBeLessThan(FAINT);
  });

  it("a note that helped stays strong for weeks", () => {
    const helped = [rating(1, "t2", "helped", 10)];
    expect(strengthOf(note(1, 12), helped, NOW)).toBeGreaterThan(FAINT);
    expect(strengthOf(note(1, 12), helped, NOW)).toBeCloseTo(Math.pow(2, -10 / (RATING_HALF_LIFE_MS / DAY)), 2);
  });

  it("an outdated rating closes a fresh note", () => {
    expect(strengthOf(note(1, 0), [rating(1, "t2", "outdated", 0)], NOW)).toBeLessThan(0);
  });

  it("counts one ticket once, by its latest rating", () => {
    const flipped = [rating(1, "t2", "helped", 2), rating(1, "t2", "outdated", 1)];
    expect(strengthOf(note(1, 0), flipped, NOW)).toBeLessThan(0);
    const twice = [rating(1, "t2", "helped", 1), rating(1, "t2", "helped", 0)];
    expect(strengthOf(note(1, 0), twice, NOW)).toBeCloseTo(2);
  });

  it("ignores ratings of other notes", () => {
    expect(strengthOf(note(1, 0), [rating(2, "t2", "outdated", 0)], NOW)).toBe(1);
  });
});

describe("strongest", () => {
  it("keeps the strongest, handed out oldest first", () => {
    const notes = [note(1, 10), note(2, 2), note(3, 0), note(4, 1)];
    const ratings = [rating(1, "t9", "helped", 1)];
    expect(strongest(notes, ratings, NOW, 3).map((n) => n.seq)).toEqual([1, 3, 4]);
  });

  it("drops faint and closed notes", () => {
    const notes = [note(1, 9), note(2, 0)];
    expect(strongest(notes, [rating(2, "t9", "outdated", 0)], NOW, 20)).toEqual([]);
  });
});
