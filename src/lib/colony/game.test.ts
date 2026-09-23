import { describe, expect, it } from "vitest";
import type { BoardCard } from "@/lib/domain/entities";
import {
  BUG_COST,
  HEAT_MAX,
  HEAT_WINDOW_MS,
  gradeOf,
  heatMerge,
  isBug,
  levelOf,
  nextUnlock,
  rankOf,
  scoreOf,
} from "./game";
import { TODAY, WINDOW_DAYS, buildTimeline } from "./timeline";

function card(p: Partial<BoardCard> & Pick<BoardCard, "id">): BoardCard {
  return {
    kind: "ticket",
    key: p.id.toUpperCase(),
    title: "Some work",
    status: "ready",
    stalledIn: null,
    stage: 1,
    position: 0,
    epicId: "e1",
    size: "M",
    storyPoints: 3,
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
    ...p,
  };
}

describe("levels", () => {
  it("steps every 50 XP and names the rank", () => {
    expect(levelOf(0)).toBe(1);
    expect(levelOf(49)).toBe(1);
    expect(levelOf(50)).toBe(2);
    expect(rankOf(1)).toBe("Scout");
    expect(rankOf(99)).toBe("Queen");
  });

  it("says what the next unlock is", () => {
    expect(nextUnlock(1)).toEqual({ level: 2, labels: ["Crimson"] });
    expect(nextUnlock(9)).toBeNull();
  });
});

describe("score", () => {
  it("counts merged tickets at 1× unless the ledger saw them land", () => {
    const cards = [
      card({ id: "a", status: "merged", storyPoints: 5 }),
      card({ id: "b", status: "merged", storyPoints: 3 }),
      card({ id: "c", status: "running", storyPoints: 8 }),
    ];
    expect(scoreOf(cards, {}).earned).toBe(8);
    expect(scoreOf(cards, { a: { pts: 13, mult: 2.5, at: 0 } }).earned).toBe(16);
  });

  it("adds an epic's story points once it merges", () => {
    const cards = [
      card({ id: "e1", kind: "epic", epicId: null, status: "merged" }),
      card({ id: "a", status: "merged", storyPoints: 5 }),
      card({ id: "b", status: "merged", storyPoints: 2 }),
    ];
    expect(scoreOf(cards, {}).earned).toBe(14);
  });

  it("charges for bugs in points but never in XP", () => {
    const cards = [
      card({ id: "a", status: "merged", storyPoints: 8 }),
      card({ id: "bug", kind: "epic", epicId: null, title: "Toast flickers on narrow screens", status: "draft" }),
    ];
    const s = scoreOf(cards, {});
    expect(s.earned).toBe(8);
    expect(s.points).toBe(8 - BUG_COST);
    expect(s.bugs).toBe(1);
    expect(s.squashed).toBe(0);
  });

  it("squashes a bug once it leaves the Backlog", () => {
    const bug = card({ id: "b", epicId: null, title: "Fix the broken badge", status: "ready" });
    expect(isBug(bug)).toBe(true);
    expect(scoreOf([bug], {}).squashed).toBe(1);
  });

  it("does not count an epic's own tickets as more bugs", () => {
    expect(isBug(card({ id: "t", title: "Fix the badge", epicId: "e1" }))).toBe(false);
  });
});

describe("heat", () => {
  it("adds half a multiplier per live stack, and stacks expire", () => {
    const first = heatMerge(4, [], 0);
    expect(first).toMatchObject({ pts: 4, mult: 1 });
    const second = heatMerge(4, first.stacks, 1000);
    expect(second).toMatchObject({ pts: 6, mult: 1.5 });
    const later = heatMerge(4, second.stacks, 1000 + HEAT_WINDOW_MS + 1);
    expect(later.mult).toBe(1);
  });

  it("holds at most six stacks", () => {
    let stacks: number[] = [];
    for (let i = 0; i < 10; i++) stacks = heatMerge(1, stacks, i).stacks;
    expect(stacks).toHaveLength(HEAT_MAX);
  });

  it("grades yield", () => {
    expect(gradeOf(2.6).grade).toBe("S");
    expect(gradeOf(2).grade).toBe("A");
    expect(gradeOf(1.5).grade).toBe("B");
    expect(gradeOf(1).grade).toBe("C");
  });
});

describe("timeline", () => {
  const at = new Date(2026, 8, 23, 12);
  const daysAgo = (n: number) => new Date(2026, 8, 23 - n, 10).toISOString();

  it("burns down merged story points and forecasts the rest", () => {
    const cards = [
      card({ id: "e1", kind: "epic", epicId: null, status: "ready" }),
      card({ id: "a", status: "merged", storyPoints: 5, startedAt: daysAgo(4), updatedAt: daysAgo(2) }),
      card({ id: "b", status: "running", storyPoints: 3, startedAt: daysAgo(1) }),
      card({ id: "c", status: "waiting", storyPoints: 2, dependsOn: ["b"] }),
    ];
    const tl = buildTimeline(cards, {}, at);

    expect(tl.days).toHaveLength(WINDOW_DAYS);
    expect(tl.total).toBe(10);
    expect(tl.remaining).toBe(5);
    expect(tl.days[TODAY - 2]!.sp).toBe(5);
    expect(tl.forecast).toBeGreaterThan(tl.now);

    const [epic] = tl.epics;
    expect(epic).toMatchObject({ doneSp: 5, totalSp: 10, merged: false });
    // 1× on the tickets plus the bonus to come.
    expect(epic!.grade?.grade).toBe("A");
    const planned = epic!.tickets.find((t) => t.id === "c")!;
    const running = epic!.tickets.find((t) => t.id === "b")!;
    expect(planned.start).toBeGreaterThanOrEqual(running.end);
  });

  it("counts a merge streak back from today", () => {
    const cards = [
      card({ id: "a", status: "merged", updatedAt: daysAgo(0) }),
      card({ id: "b", status: "merged", updatedAt: daysAgo(1) }),
      card({ id: "c", status: "merged", updatedAt: daysAgo(3) }),
    ];
    expect(buildTimeline(cards, {}, at).streak).toBe(2);
  });

  it("leaves work merged before the window out of the burndown", () => {
    const cards = [
      card({ id: "a", status: "merged", storyPoints: 8, updatedAt: daysAgo(40) }),
      card({ id: "b", status: "ready", storyPoints: 2 }),
    ];
    const tl = buildTimeline(cards, {}, at);
    expect(tl.total).toBe(2);
    expect(tl.forecast).toBeNull();
  });
});
