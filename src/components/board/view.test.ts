import { describe, it, expect } from "vitest";
import { applyView, isViewActive, EMPTY_VIEW } from "./view";
import type { BoardCard } from "@/lib/domain/entities";

const makeCard = (overrides: Partial<BoardCard>): BoardCard => ({
  id: "card-1",
  kind: "ticket",
  key: "FOR-1",
  title: "Fix login",
  status: "ready",
  stalledIn: null,
  stage: 1,
  position: 0,
  epicId: null,
  workType: null,
  size: "M",
  storyPoints: null,
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
  createdAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

describe("board view logic", () => {
  it("EMPTY_VIEW returns the same order and is not active", () => {
    const cards = [
      makeCard({ id: "1", title: "Add export" }),
      makeCard({ id: "2", title: "Fix login" }),
    ];
    expect(applyView(cards, EMPTY_VIEW)).toEqual(cards);
    expect(isViewActive(EMPTY_VIEW)).toBe(false);
  });

  it("filters by query case-insensitively over key and title", () => {
    const cards = [
      makeCard({ id: "1", key: "FOR-1", title: "Fix login bug" }),
      makeCard({ id: "2", key: "FOR-2", title: "Add export feature" }),
      makeCard({ id: "3", key: "BUG-99", title: "Something else" }),
    ];

    const res1 = applyView(cards, { ...EMPTY_VIEW, query: "LOGIN" });
    expect(res1.map((c) => c.id)).toEqual(["1"]);

    const res2 = applyView(cards, { ...EMPTY_VIEW, query: "for-2" });
    expect(res2.map((c) => c.id)).toEqual(["2"]);

    const res3 = applyView(cards, { ...EMPTY_VIEW, query: "bug" });
    expect(res3.map((c) => c.id)).toEqual(["1", "3"]);
  });

  it("filters by workType", () => {
    const cards = [
      makeCard({ id: "1", workType: "bug" }),
      makeCard({ id: "2", workType: "spike" }),
      makeCard({ id: "3", workType: null }),
    ];

    const bugs = applyView(cards, { ...EMPTY_VIEW, workType: "bug" });
    expect(bugs.map((c) => c.id)).toEqual(["1"]);

    const spikes = applyView(cards, { ...EMPTY_VIEW, workType: "spike" });
    expect(spikes.map((c) => c.id)).toEqual(["2"]);
  });

  it("sorts by title", () => {
    const cards = [
      makeCard({ id: "1", title: "Zebra" }),
      makeCard({ id: "2", title: "Apple" }),
      makeCard({ id: "3", title: "Banana" }),
    ];
    const sorted = applyView(cards, { ...EMPTY_VIEW, sort: "title" });
    expect(sorted.map((c) => c.title)).toEqual(["Apple", "Banana", "Zebra"]);
  });

  it("sorts by newest, cards without createdAt sort last", () => {
    const cards = [
      makeCard({ id: "1", createdAt: undefined }),
      makeCard({ id: "2", createdAt: "2025-01-02T00:00:00.000Z" }),
      makeCard({ id: "3", createdAt: "2025-01-05T00:00:00.000Z" }),
    ];
    const sorted = applyView(cards, { ...EMPTY_VIEW, sort: "newest" });
    expect(sorted.map((c) => c.id)).toEqual(["3", "2", "1"]);
  });

  it("sorts by points with highest first, cards without points sort last", () => {
    const cards = [
      makeCard({ id: "1", storyPoints: 2 }),
      makeCard({ id: "2", storyPoints: null }),
      makeCard({ id: "3", storyPoints: 8 }),
    ];
    const sorted = applyView(cards, { ...EMPTY_VIEW, sort: "points" });
    expect(sorted.map((c) => c.id)).toEqual(["3", "1", "2"]);
  });

  it("isViewActive correctly detects active view conditions", () => {
    expect(isViewActive(EMPTY_VIEW)).toBe(false);
    expect(isViewActive({ ...EMPTY_VIEW, query: "abc" })).toBe(true);
    expect(isViewActive({ ...EMPTY_VIEW, sort: "title" })).toBe(true);
    expect(isViewActive({ ...EMPTY_VIEW, workType: "bug" })).toBe(true);
    expect(isViewActive({ ...EMPTY_VIEW, collapsed: true })).toBe(true);
  });
});
