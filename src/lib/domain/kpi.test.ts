import { describe, expect, it } from "vitest";
import { computeKpis, cycleTime, inWindow, leadTime, reviewPassRate, throughputPerWeek, timeInColumn, type ColumnStay, type KpiTicket } from "./kpi";
import type { ColumnId } from "./status";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22);

/** Stays given as [column, startDay, endDay | null, synthetic?], days before NOW's day 0. */
function ticket(id: string, stays: [ColumnId, number, number | null, boolean?][], over: Partial<KpiTicket> = {}): KpiTicket {
  return {
    id,
    storyPoints: 2,
    attempts: 1,
    scopeRequests: 0,
    blockedOrFailed: false,
    costUsd: 1,
    stays: stays.map(([column, a, b, synthetic]): ColumnStay => ({
      column,
      enteredAt: new Date(a * DAY),
      leftAt: b === null ? null : new Date(b * DAY),
      synthetic,
    })),
    ...over,
  };
}

describe("reviewPassRate", () => {
  it("is 50% for a ticket sent back from In Review once and then Done", () => {
    const t = ticket("a", [["in_progress", 0, 1], ["in_review", 1, 2], ["in_progress", 2, 3], ["in_review", 3, 4], ["done", 4, null]]);
    expect(reviewPassRate([t])).toBe(0.5);
  });
});

describe("timeInColumn", () => {
  it("leaves out synthetic entries", () => {
    const t = ticket("a", [["in_progress", 0, 2], ["in_review", 2, 12, true], ["in_review", 12, 13]]);
    const times = timeInColumn(t, NOW);
    expect(times.in_review).toBe(DAY);
    expect(times.in_progress).toBe(2 * DAY);
  });
});

describe("computeKpis", () => {
  it("has the largest average time in In Review when tickets stay longest there", () => {
    const t = ticket("a", [["todo", 0, 1], ["in_progress", 1, 2], ["in_review", 2, 9], ["done", 9, null]]);
    const avg = computeKpis([t], "all", 10 * DAY).averageTimePerColumn;
    const max = Math.max(...Object.values(avg).map((v) => v ?? 0));
    expect(avg.in_review).toBe(max);
  });

  it("gives empty values, not NaN, for no tickets", () => {
    const k = computeKpis([], "recent", NOW);
    expect(k.tickets).toBe(0);
    expect(k.reviewPassRate).toBeNull();
    expect(k.throughputPerWeek).toBeNull();
    expect(k.costPerStoryPoint).toBeNull();
    expect(k.blockedFailedRate).toBeNull();
    expect(k.precisionCount).toBe(0);
    expect(Object.values(k.averageTimePerColumn).every((v) => v === null)).toBe(true);
  });

  it("computes rates, cost and counts", () => {
    const a = ticket("a", [["todo", 0, 1], ["in_progress", 1, 3], ["done", 3, null]], { costUsd: 4, storyPoints: 2 });
    const b = ticket("b", [["todo", 0, 1], ["in_progress", 1, 2]], { costUsd: 2, storyPoints: 2, attempts: 3, scopeRequests: 1, blockedOrFailed: true });
    const k = computeKpis([a, b], "all", 7 * DAY);
    expect(k.costPerStoryPoint).toBe(1.5);
    expect(k.blockedFailedRate).toBe(0.5);
    expect(k.averageAttempts).toBe(2);
    expect(k.averageScopeRequests).toBe(0.5);
    expect(k.precisionCount).toBe(1);
  });
});

describe("lead, cycle and throughput", () => {
  const t = ticket("a", [["todo", 0, 1], ["in_progress", 1, 3], ["done", 3, null]]);
  it("measures from To Do and from In Progress to Done", () => {
    expect(leadTime(t)).toBe(3 * DAY);
    expect(cycleTime(t)).toBe(2 * DAY);
    expect(leadTime(ticket("b", [["todo", 0, null]]))).toBeNull();
  });
  it("counts Done tickets per week", () => {
    expect(throughputPerWeek([t, t], 17 * DAY)).toBe(2 / 2);
  });
});

describe("inWindow", () => {
  it("keeps only the last 30 days for recent", () => {
    const old = ticket("old", [["done", 0, null]]);
    const fresh = ticket("fresh", [["done", NOW / DAY - 2, null]]);
    expect(inWindow([old, fresh], "recent", NOW).map((t) => t.id)).toEqual(["fresh"]);
    expect(inWindow([old, fresh], "all", NOW)).toHaveLength(2);
  });
});
