import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BoardShell } from "./board-shell";
import { makeCard } from "@/test/cards";
import type { BoardCard } from "@/lib/domain/entities";
import type { AmbientStats } from "@/components/ui/ambient-drawer";

/**
 * Composition level: the shell wired to its board, with every data hook
 * stubbed so nothing reaches the network or the event stream. What it covers
 * is that the cards the shell is given come out in the right columns.
 */
const board = vi.hoisted(() => ({ cards: [] as BoardCard[] }));

vi.mock("@/lib/hooks/use-board", () => ({
  useBoard: (_cards: BoardCard[], stats: AmbientStats) => ({
    cards: board.cards,
    extras: {},
    stats,
    prdStreams: {},
    connection: "live",
    transition: vi.fn(),
    createEpic: vi.fn(),
    createTicket: vi.fn(),
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/use-agents", () => ({
  useAgents: () => ({
    presets: [],
    columns: {},
    overrides: {},
    usage: {},
    window: { kind: "all-time", since: null, timezone: null },
    markLimited: vi.fn(),
    refreshUsage: vi.fn(),
    assign: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    setOverride: vi.fn(),
    resetWindow: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/use-assistant", () => ({
  useAssistant: () => ({
    presetId: null,
    messages: [],
    error: null,
    asking: false,
    ask: vi.fn(),
    setAgent: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/use-runner-setup", () => ({
  useRunnerSetup: () => ({ setup: null, check: vi.fn() }),
}));

const stats: AmbientStats = {
  activeSandboxes: 0,
  provider: "claude",
  tokensIn: 0,
  tokensOut: 0,
  costCents: 0,
  logLines: [],
};

function renderShell(cards: BoardCard[]) {
  board.cards = cards;
  render(
    <BoardShell
      initialCards={cards}
      projectName="Formic"
      repoFullName="formic-labs/formic-web"
      initialStats={stats}
    />,
  );
}

describe("BoardShell", () => {
  it("shows the columns and the tickets in them", () => {
    renderShell([
      makeCard({ status: "ready", title: "Fix login" }),
      makeCard({ status: "merged", title: "Add export" }),
    ]);
    const todo = screen.getByRole("region", { name: "To Do" });
    expect(within(todo).getByText("Fix login")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Done" })).toBeInTheDocument();
    expect(screen.getByText("Add export")).toBeInTheDocument();
  });

  it("shows an empty state in each column when the board has no cards", () => {
    renderShell([]);
    const todo = screen.getByRole("region", { name: "To Do" });
    expect(within(todo).getByText("Nothing here.")).toBeInTheDocument();
  });
});
