import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BoardShell } from "./board-shell";
import { activeTour, endTour, forgetTours, hasSeen } from "@/components/onboarding/store";
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

function renderShell(cards: BoardCard[], props: Partial<React.ComponentProps<typeof BoardShell>> = {}) {
  board.cards = cards;
  render(
    <BoardShell
      initialCards={cards}
      projectName="Formic"
      repoFullName="formic-labs/formic-web"
      initialStats={stats}
      {...props}
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

  it("shows archived cards in their original column only when Archived is toggled on", async () => {
    const archived = makeCard({ status: "ready", title: "Old todo", archived: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ tickets: [archived] }) })),
    );
    renderShell([]);
    expect(screen.queryByText("Old todo")).toBeNull();
    const todo = screen.getByRole("region", { name: "To Do" });
    fireEvent.click(within(todo).getByRole("button", { name: "Column options" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /archived/i }));
    expect(await within(todo).findByText("Old todo")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("shows an agent menu on every working column", () => {
    renderShell([makeCard({ status: "ready" })]);
    expect(screen.getAllByRole("button", { name: /^Agent for / }).length).toBeGreaterThan(0);
  });

  it("shows an empty state in each column when the board has no cards", () => {
    renderShell([]);
    const todo = screen.getByRole("region", { name: "To Do" });
    expect(within(todo).getByText("Nothing here.")).toBeInTheDocument();
  });

  describe("board tour", () => {
    afterEach(() => {
      endTour();
      forgetTours();
      vi.unstubAllGlobals();
    });

    it("offers the tour and tells the server when this person has not seen it", async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      vi.stubGlobal("fetch", fetchMock);
      renderShell([], { projectId: "p1", tourSeen: false });
      await waitFor(() => expect(activeTour()).toBe("board"), { timeout: 3000 });
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/tour-seen",
          expect.objectContaining({ method: "POST", body: JSON.stringify({ projectId: "p1" }) }),
        ),
      );
    });

    it("keeps the tour going when the server cannot be told", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (url === "/api/projects/tour-seen") throw new Error("offline"); return { ok: true, json: async () => ({}) }; }));
      renderShell([], { projectId: "p1", tourSeen: false });
      await waitFor(() => expect(activeTour()).toBe("board"), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 20));
      expect(activeTour()).toBe("board");
    });

    it("does not offer the tour, and agrees locally, when the server says it was seen", async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      vi.stubGlobal("fetch", fetchMock);
      renderShell([], { projectId: "p1", tourSeen: true });
      await new Promise((r) => setTimeout(r, 1200));
      expect(activeTour()).toBeNull();
      expect(hasSeen("board")).toBe(true);
      expect(fetchMock).not.toHaveBeenCalledWith("/api/projects/tour-seen", expect.anything());
    });
  });

  describe("colony bar", () => {
    /** The bar is the root's last in-flow child, so nothing pushes it out of the h-dvh column. */
    function expectBarAtBottom() {
      const root = document.querySelector("[data-board-root]")!;
      const bar = screen.getByRole("contentinfo");
      expect(bar.parentElement).toBe(root);
      expect(bar).toHaveClass("shrink-0");
      expect(root).toHaveClass("h-dvh", "overflow-hidden");
      // The bar renders its nest once per layout (wide and narrow).
      expect(within(bar).getAllByRole("button", { name: /open colony/i }).length).toBeGreaterThan(0);
    }

    it("is shown on a board with cards", () => {
      renderShell([makeCard({ status: "ready" })]);
      expectBarAtBottom();
    });

    it("is shown on a board with no cards", () => {
      renderShell([]);
      expectBarAtBottom();
    });

    it("is shown with the setup banners up", () => {
      renderShell([], { noCi: true, noSandboxKey: true });
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expectBarAtBottom();
    });

    it("opens the colony from the nest", () => {
      // jsdom has no Web Animations; the popover animates open.
      Element.prototype.animate ??= () => ({ finished: Promise.resolve(), cancel() {}, onfinish: null }) as unknown as Animation;
      renderShell([]);
      const nest = within(screen.getByRole("contentinfo")).getAllByRole("button", { name: /open colony/i })[0]!;
      expect(nest).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(nest);
      expect(nest).toHaveAttribute("aria-expanded", "true");
    });
  });
});
