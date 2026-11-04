import { describe, expect, it } from "vitest";
import { nextOccurrenceAfter, occurrencesBetween, type Meeting } from "./recurrence";

// Local-time constructors: recurrence is anchored on the local time of day.
const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m - 1, d, h, min);

// 2026-06-01 is a Monday.
const monday = at(2026, 6, 1);
const twoWeeks = [monday, at(2026, 6, 15)] as const;

describe("occurrencesBetween", () => {
  it("returns ten weekday occurrences over two weeks, none on a weekend", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "weekdays" };
    const result = occurrencesBetween(meeting, ...twoWeeks);
    expect(result).toHaveLength(10);
    for (const d of result) expect([0, 6]).not.toContain(d.getDay());
  });

  it("returns exactly one occurrence of a biweekly meeting over two weeks", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "biweekly" };
    expect(occurrencesBetween(meeting, ...twoWeeks)).toEqual([monday]);
  });

  it("returns every week for a weekly meeting", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "weekly" };
    expect(occurrencesBetween(meeting, ...twoWeeks)).toEqual([monday, at(2026, 6, 8)]);
  });

  it("returns nothing for a non-repeating meeting outside the range", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "none" };
    expect(occurrencesBetween(meeting, at(2026, 6, 8), at(2026, 6, 22))).toEqual([]);
  });

  it("returns a non-repeating meeting inside the range", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "none" };
    expect(occurrencesBetween(meeting, ...twoWeeks)).toEqual([monday]);
  });

  it("does not return occurrences before startsAt", () => {
    const meeting: Meeting = { startsAt: at(2026, 6, 10), repeat: "weekdays" };
    const result = occurrencesBetween(meeting, ...twoWeeks);
    expect(result[0]).toEqual(at(2026, 6, 10));
  });

  it("keeps the local time of day across a DST change", () => {
    const meeting: Meeting = { startsAt: at(2026, 1, 5, 9, 30), repeat: "weekly" };
    const result = occurrencesBetween(meeting, at(2026, 1, 1), at(2026, 12, 31));
    expect(result.length).toBeGreaterThan(50);
    for (const d of result) {
      expect([d.getHours(), d.getMinutes()]).toEqual([9, 30]);
    }
  });
});

describe("nextOccurrenceAfter", () => {
  it("returns the next weekday after a Friday occurrence, skipping the weekend", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "weekdays" };
    expect(nextOccurrenceAfter(meeting, at(2026, 6, 5))).toEqual(at(2026, 6, 8));
  });

  it("returns startsAt when asked before it", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "biweekly" };
    expect(nextOccurrenceAfter(meeting, at(2026, 5, 1))).toEqual(monday);
  });

  it("returns the following biweekly slot", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "biweekly" };
    expect(nextOccurrenceAfter(meeting, monday)).toEqual(at(2026, 6, 15));
  });

  it("returns null for a non-repeating meeting already past", () => {
    const meeting: Meeting = { startsAt: monday, repeat: "none" };
    expect(nextOccurrenceAfter(meeting, at(2026, 6, 2))).toBeNull();
  });
});
