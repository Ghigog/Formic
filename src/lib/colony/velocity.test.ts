import { describe, expect, it } from "vitest";
import type { BoardCard } from "@/lib/domain/entities";
import { MIN_ACTIVE_DAYS, measureVelocity } from "./velocity";

const at = new Date(2026, 8, 23, 12);

function merged(id: string, sp: number, daysAgo: number): BoardCard {
  return {
    id,
    kind: "ticket",
    key: id.toUpperCase(),
    title: "Some work",
    status: "merged",
    stalledIn: null,
    stage: 1,
    position: 0,
    epicId: "e1",
    size: "M",
    storyPoints: sp,
    agentRole: null,
    model: null,
    fileScope: [],
    dependsOn: [],
    prNumber: null,
    prUrl: null,
    blockedReason: null,
    costCents: 0,
    childCount: 0,
    doneCount: 0,
    mergedAt: new Date(2026, 8, 23 - daysAgo, 10).toISOString(),
  };
}

describe("measureVelocity", () => {
  it("is the median of story points merged per active day", () => {
    const cards = [
      merged("a", 2, 0),
      merged("b", 3, 0), // day total 5
      merged("c", 1, 1),
      merged("d", 8, 2),
      merged("e", 20, 3),
      merged("f", 4, 4),
    ];
    expect(measureVelocity(cards, at)).toBe(5);
  });

  it("does not count days without merges", () => {
    // Five merges spread over ten days: only the five active days count.
    const cards = [0, 2, 4, 6, 9].map((d, i) => merged(`t${i}`, 10, d));
    expect(measureVelocity(cards, at)).toBe(10);
    expect(measureVelocity(cards.slice(1), at)).toBeNull();
  });

  it("is null below the minimum active days", () => {
    const cards = Array.from({ length: MIN_ACTIVE_DAYS - 1 }, (_, i) => merged(`t${i}`, 5, i));
    expect(measureVelocity(cards, at)).toBeNull();
  });

  it("ignores merges older than the window", () => {
    const cards = Array.from({ length: 5 }, (_, i) => merged(`t${i}`, 5, 40 + i));
    expect(measureVelocity(cards, at)).toBeNull();
  });
});
