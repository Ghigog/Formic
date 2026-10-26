import { describe, expect, it } from "vitest";
import type { BoardCard } from "@/lib/domain/entities";
import { TODAY, buildTimeline } from "./timeline";

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

const epic = { ...merged("e1", 1, 0), kind: "epic", epicId: null, status: "ready", mergedAt: null } as BoardCard;
const history = (n: number) => Array.from({ length: n }, (_, i) => merged(`m${i}`, 10, i));
const ticket = (p: Partial<BoardCard>): BoardCard => ({ ...merged("x", 5, 0), mergedAt: null, ...p });

function ends(cards: BoardCard[]) {
  const tl = buildTimeline(cards, at);
  const tickets = tl.epics.flatMap((e) => e.tickets);
  return Object.fromEntries(tickets.map((t) => [t.id, t]));
}

describe("buildTimeline projections", () => {
  const open = [
    ticket({ id: "plan", status: "ready", storyPoints: 5 }),
    ticket({ id: "fly", status: "running", storyPoints: 8, startedAt: at.toISOString() }),
  ];

  it("projects at the measured velocity", () => {
    const t = ends([epic, ...history(5), ...open]);
    expect(t.plan!.end - t.plan!.start).toBeCloseTo(0.5);
    expect(t.fly!.end).toBeCloseTo(TODAY + 1 + 0.8);
  });

  it("keeps the fixed projections without enough history", () => {
    const t = ends([epic, ...history(4), ...open]);
    expect(t.plan!.end - t.plan!.start).toBe(3);
    expect(t.fly!.end).toBe(TODAY + 1 + 2);
  });
});
