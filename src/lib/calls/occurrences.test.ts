import { describe, expect, it } from "vitest";
import type { Meeting } from "@/lib/db/repository";
import { occurrencesBetween } from "./occurrences";

const meeting = (startsAt: Date, repeat: Meeting["repeat"]): Meeting => ({
  id: "m1",
  projectId: "p",
  title: "Stand-up",
  startsAt,
  agenda: "",
  guests: [],
  repeat,
  lastRemindedFor: null,
  createdAt: new Date(0),
});

// Monday 3 Nov 2025, local time.
const monday = new Date(2025, 10, 3);
const at = (d: number, h = 9) => new Date(2025, 10, d, h);
const days = (m: Meeting, from = monday, to = at(17, 0)) =>
  occurrencesBetween([m], from, to).map((o) => o.at.getDate());

describe("occurrencesBetween", () => {
  it("returns a one-off meeting once, only inside the range", () => {
    expect(days(meeting(at(5), "none"))).toEqual([5]);
    expect(days(meeting(at(20), "none"))).toEqual([]);
  });

  it("repeats on weekdays, skipping weekends", () => {
    expect(days(meeting(at(3), "weekdays"))).toEqual([3, 4, 5, 6, 7, 10, 11, 12, 13, 14]);
  });

  it("repeats weekly and every other week", () => {
    expect(days(meeting(at(4), "weekly"))).toEqual([4, 11]);
    expect(days(meeting(at(4), "biweekly"))).toEqual([4]);
  });

  it("does not occur before the meeting starts", () => {
    expect(days(meeting(at(6), "weekdays"))).toEqual([6, 7, 10, 11, 12, 13, 14]);
  });

  it("keeps the time of day", () => {
    const [o] = occurrencesBetween([meeting(at(3, 14), "weekdays")], at(4, 0), at(5, 0));
    expect(o!.at.getHours()).toBe(14);
  });
});
