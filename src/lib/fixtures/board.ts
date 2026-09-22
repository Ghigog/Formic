import type { BoardCard } from "@/lib/domain/entities";

/**
 * Demo data. Covers one Epic with children, a card in every column, a running
 * card, a card in review, and a failed card, so every visual state on the
 * board has something to render before the database exists.
 */

function card(partial: Partial<BoardCard> & Pick<BoardCard, "id" | "key" | "title" | "status">): BoardCard {
  return {
    kind: "ticket",
    stalledIn: null,
    stage: 1,
    position: 0,
    epicId: null,
    size: "M",
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
    ...partial,
  };
}

export const FIXTURE_CARDS: BoardCard[] = [
  card({
    id: "epic-1",
    kind: "epic",
    key: "EPIC-1",
    title: "Let reviewers leave inline comments on a showcase",
    status: "draft",
    stage: 1,
    position: 1000,
    size: null,
  }),
  card({
    id: "epic-2",
    kind: "epic",
    key: "EPIC-2",
    title: "Saved board filters per project",
    status: "specified",
    stage: 2,
    position: 2000,
    size: null,
    agentRole: "product",
    model: "claude-opus-5",
  }),

  card({
    id: "epic-3",
    kind: "epic",
    key: "EPIC-3",
    title: "Keyboard navigation across the board",
    status: "ready",
    stage: 3,
    position: 1000,
    size: null,
    childCount: 4,
    doneCount: 1,
    agentRole: "architect",
    model: "claude-opus-5",
  }),
  card({
    id: "t-1",
    key: "FOR-101",
    title: "Roving tabindex across columns",
    status: "ready",
    stage: 3,
    position: 1100,
    epicId: "epic-3",
    size: "M",
    fileScope: ["src/components/board"],
  }),
  card({
    id: "t-2",
    key: "FOR-102",
    title: "Shortcut help overlay",
    status: "waiting",
    stage: 3,
    position: 1200,
    epicId: "epic-3",
    size: "S",
    fileScope: ["src/components/ui"],
    dependsOn: ["t-1"],
  }),
  card({
    id: "t-3",
    key: "FOR-103",
    title: "Announce card moves to screen readers",
    status: "failed",
    stalledIn: "todo",
    stage: 5,
    position: 1300,
    epicId: "epic-3",
    size: "S",
    fileScope: ["src/lib/a11y"],
    blockedReason: "Coder agent edited outside its file scope (src/app/page.tsx)",
    costCents: 42,
  }),

  card({
    id: "t-4",
    key: "FOR-104",
    title: "Persist column order with a fractional index",
    status: "running",
    stage: 5,
    position: 1000,
    epicId: "epic-3",
    size: "M",
    fileScope: ["src/lib/ordering"],
    agentRole: "coder",
    model: "claude-opus-5",
    costCents: 88,
  }),

  card({
    id: "t-5",
    key: "FOR-105",
    title: "Drag handle hit area on touch devices",
    status: "review",
    stage: 7,
    position: 1000,
    epicId: "epic-3",
    size: "S",
    fileScope: ["src/components/board/card.tsx"],
    agentRole: "reviewer",
    model: "claude-opus-5",
    prNumber: 42,
    prUrl: "https://github.com/example/formic/pull/42",
    costCents: 31,
  }),

  card({
    id: "t-6",
    key: "FOR-100",
    title: "Column scaffolding and layout grid",
    status: "merged",
    stage: 8,
    position: 1000,
    epicId: "epic-3",
    size: "M",
    fileScope: ["src/components/board/column.tsx"],
    prNumber: 38,
    prUrl: "https://github.com/example/formic/pull/38",
    costCents: 55,
  }),
];

export const FIXTURE_CI: Record<string, "pending" | "passing" | "failing"> = {
  "t-5": "failing",
};

export const FIXTURE_PROGRESS: Record<string, { label: string; fraction: number | null }> = {
  "t-4": { label: "Running tests", fraction: 0.6 },
};
