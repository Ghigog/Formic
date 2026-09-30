import { describe, expect, it } from "vitest";
import {
  byCompletion,
  needsRebalance,
  positionBetween,
  positionForIndex,
  rebalance,
} from "./ordering";

describe("positionBetween", () => {
  it("seeds an empty column", () => {
    expect(positionBetween(null, null)).toBe(1000);
  });

  it("places before the first card", () => {
    expect(positionBetween(null, 1000)).toBeLessThan(1000);
  });

  it("appends after the last card", () => {
    expect(positionBetween(1000, null)).toBeGreaterThan(1000);
  });

  it("splits the gap between two cards", () => {
    const p = positionBetween(1000, 2000);
    expect(p).toBeGreaterThan(1000);
    expect(p).toBeLessThan(2000);
  });
});

describe("positionForIndex", () => {
  const positions = [1000, 2000, 3000];

  it("handles the head", () => {
    expect(positionForIndex(positions, 0)).toBeLessThan(1000);
  });

  it("handles the tail", () => {
    expect(positionForIndex(positions, 3)).toBeGreaterThan(3000);
  });

  it("handles the middle", () => {
    const p = positionForIndex(positions, 1);
    expect(p).toBeGreaterThan(1000);
    expect(p).toBeLessThan(2000);
  });

  it("seeds an empty column", () => {
    expect(positionForIndex([], 0)).toBe(1000);
  });
});

describe("rebalance", () => {
  it("detects exhausted precision", () => {
    let lo = 1000;
    const hi = 1001;
    for (let i = 0; i < 60; i++) lo = (lo + hi) / 2;
    expect(needsRebalance([1000, lo, hi])).toBe(true);
  });

  it("leaves a healthy column alone", () => {
    expect(needsRebalance([1000, 2000, 3000])).toBe(false);
  });

  it("renumbers evenly", () => {
    expect(rebalance(3)).toEqual([1000, 2000, 3000]);
  });
});

describe("byCompletion", () => {
  const card = (partial: Partial<{ mergedAt: string | null; updatedAt: string; position: number }>) =>
    ({ position: 1000, updatedAt: "", ...partial });

  it("sorts most recently completed first, whatever the positions say", () => {
    const older = card({ mergedAt: "2025-01-01T10:00:00Z", position: 1000 });
    const newer = card({ mergedAt: "2025-01-02T10:00:00Z", position: 2000 });
    expect([older, newer].sort(byCompletion)).toEqual([newer, older]);
    expect([newer, older].sort(byCompletion)).toEqual([newer, older]);
  });

  it("prefers mergedAt over updatedAt", () => {
    const merged = card({ mergedAt: "2025-01-01T10:00:00Z", updatedAt: "2025-01-03T10:00:00Z" });
    const updated = card({ mergedAt: "2025-01-02T10:00:00Z", updatedAt: "2025-01-04T10:00:00Z" });
    expect([merged, updated].sort(byCompletion)).toEqual([updated, merged]);
  });

  it("falls back to updatedAt when mergedAt is not set, as epics do", () => {
    const epic = card({ mergedAt: null, updatedAt: "2025-01-05T10:00:00Z" });
    const ticket = card({ mergedAt: "2025-01-04T10:00:00Z", updatedAt: "2025-01-01T10:00:00Z" });
    expect([ticket, epic].sort(byCompletion)).toEqual([epic, ticket]);
  });

  it("breaks ties on position", () => {
    const first = card({ mergedAt: "2025-01-01T10:00:00Z", position: 1000 });
    const second = card({ mergedAt: "2025-01-01T10:00:00Z", position: 2000 });
    expect([second, first].sort(byCompletion)).toEqual([first, second]);
  });
});
