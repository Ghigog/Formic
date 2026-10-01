import { describe, expect, it } from "vitest";
import { tokenWindow } from "./index";

const none = { renewalDay: null, timezone: null, resetAt: null };

describe("tokenWindow", () => {
  it("starts at the 5th of this month when now is 30 September", () => {
    const w = tokenWindow({ ...none, renewalDay: 5, timezone: "UTC" }, new Date("2026-09-30T12:00:00Z"));
    expect(w).toEqual({ since: new Date("2026-09-05T00:00:00Z"), kind: "renewal" });
  });

  it("uses last month's day when this month's has not come", () => {
    const w = tokenWindow({ ...none, renewalDay: 5, timezone: "UTC" }, new Date("2026-10-03T12:00:00Z"));
    expect(w.since).toEqual(new Date("2026-09-05T00:00:00Z"));
  });

  it("rolls over at 5 October local midnight, not the server's", () => {
    const settings = { ...none, renewalDay: 5, timezone: "America/New_York" };
    // 5 Oct 00:00 in New York (EDT, UTC-4) is 04:00 UTC.
    const before = tokenWindow(settings, new Date("2026-10-05T03:59:59Z"));
    const after = tokenWindow(settings, new Date("2026-10-05T04:00:00Z"));
    expect(before.since).toEqual(new Date("2026-09-05T04:00:00Z"));
    expect(after.since).toEqual(new Date("2026-10-05T04:00:00Z"));
  });

  it("falls on the last day when the month is shorter than the renewal day", () => {
    const feb = tokenWindow({ ...none, renewalDay: 31, timezone: "UTC" }, new Date("2026-03-15T00:00:00Z"));
    expect(feb.since).toEqual(new Date("2026-02-28T00:00:00Z"));
    const sep = tokenWindow({ ...none, renewalDay: 31, timezone: "UTC" }, new Date("2026-09-30T12:00:00Z"));
    expect(sep.since).toEqual(new Date("2026-09-30T00:00:00Z"));
  });

  it("goes back across the year", () => {
    const w = tokenWindow({ ...none, renewalDay: 20, timezone: "UTC" }, new Date("2026-01-10T00:00:00Z"));
    expect(w.since).toEqual(new Date("2025-12-20T00:00:00Z"));
  });

  it("uses the reset time when there is no renewal day", () => {
    const resetAt = new Date("2026-09-12T08:00:00Z");
    expect(tokenWindow({ ...none, resetAt }, new Date("2026-09-30T00:00:00Z"))).toEqual({
      since: resetAt,
      kind: "reset",
    });
  });

  it("is all time with neither", () => {
    expect(tokenWindow(none, new Date("2026-09-30T00:00:00Z"))).toEqual({ since: null, kind: "all-time" });
  });
});
