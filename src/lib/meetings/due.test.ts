import { describe, expect, it } from "vitest";
import type { Meeting } from "@/lib/db/repository";
import { dueOccurrence, upNext } from "./due";

const now = new Date(2025, 10, 5, 10, 0);
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const meeting = (startsAt: Date, repeat: Meeting["repeat"] = "none"): Meeting => ({
  id: "m1", projectId: "p", title: "Standup", startsAt, agenda: "", guests: [], repeat, lastRemindedFor: null, createdAt: new Date(0),
});

describe("dueOccurrence", () => {
  it("is due 10 minutes before the start", () => expect(dueOccurrence([meeting(at(10))], now)?.meeting.id).toBe("m1"));
  it("is not due 20 minutes before", () => expect(dueOccurrence([meeting(at(20))], now)).toBeNull());
  it("is due while running", () => expect(dueOccurrence([meeting(at(-30))], now)).not.toBeNull());
  it("is not due long after it started", () => expect(dueOccurrence([meeting(at(-90))], now)).toBeNull());
  it("is due for a repeat's occurrence today", () => expect(dueOccurrence([meeting(at(10 - 7 * 1440), "weekly")], now)).not.toBeNull());
});

describe("upNext", () => {
  it("picks the soonest meeting that has not ended", () => {
    const later = { ...meeting(at(300)), id: "later" };
    expect(upNext([later, meeting(at(60))], now)?.meeting.id).toBe("m1");
  });
  it("is null with no meetings", () => expect(upNext([], now)).toBeNull());
});
