import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board, type BoardProps } from "./board";
import { saveBoardView, BOARD_VIEW_KEY } from "./view-setting";
import { EMPTY_VIEW } from "./view";
import { makeCard, makeEpicWithChildren } from "@/test/cards";
import { setViewportMatches } from "@/test/viewport";
import type { BoardCard } from "@/lib/domain/entities";
import type { TransitionResult } from "@/lib/domain/transitions";

/**
 * Integration level: the board wired to its columns and cards, with the
 * server replaced by a spy. What it is for is the trigger contract — a user
 * move must produce exactly one typed transition, and a refusal must put the
 * card back — because every later ticket hangs off that one event.
 *
 * The drag gesture itself is not here. jsdom reports every box as 0×0, so
 * @hello-pangea/dnd cannot decide where a card landed. Dragging is covered in
 * e2e/board.spec.ts against a real browser and a real server.
 */
function renderBoard(
  cards: BoardCard[],
  overrides: Partial<BoardProps> = {},
): { onTransition: ReturnType<typeof vi.fn> } {
  const onTransition = vi.fn(
    async (): Promise<TransitionResult> => ({ ok: true, status: "ready", runId: null }),
  );

  render(
    <Board
      cards={cards}
      projectName="Formic"
      repoFullName="formic-labs/formic-web"
      onOpenCard={vi.fn()}
      onNewItem={vi.fn()}
      onTransition={onTransition}
      {...overrides}
    />,
  );

  return { onTransition };
}

describe("Board column views", () => {
  it("keeps a column's search when the cards update", async () => {
    const cards = [
      makeCard({ status: "ready", title: "Fix login" }),
      makeCard({ status: "ready", title: "Add export" }),
    ];
    const onTransition = vi.fn();
    const props = {
      projectName: "Formic",
      repoFullName: "formic-labs/formic-web",
      onOpenCard: vi.fn(),
      onNewItem: vi.fn(),
      onTransition,
    };
    const { rerender } = render(<Board cards={cards} {...props} />);
    const todo = screen.getByRole("region", { name: "To Do" });
    const user = userEvent.setup();
    await user.click(within(todo).getByRole("button", { name: "Column options" }));
    await user.type(screen.getByPlaceholderText("Search key or title..."), "login");
    expect(within(todo).queryByText("Add export")).toBeNull();

    rerender(
      <Board cards={[...cards, makeCard({ status: "ready", title: "Other" })]} {...props} />,
    );
    expect(within(todo).getByText("Fix login")).toBeInTheDocument();
    expect(within(todo).queryByText("Add export")).toBeNull();
    expect(within(todo).queryByText("Other")).toBeNull();
  });
});

describe("Board seeded from the saved board view", () => {
  afterEach(() => window.localStorage.clear());

  it("filters and sorts every column by the saved view", async () => {
    saveBoardView({ ...EMPTY_VIEW, sort: "title", types: ["bug"] });
    renderBoard([
      makeCard({ status: "ready", title: "Zed bug", workType: "bug" }),
      makeCard({ status: "ready", title: "Alpha bug", workType: "bug" }),
      makeCard({ status: "ready", title: "Plain" }),
      makeCard({ status: "draft", title: "Backlog plain" }),
    ]);
    const todo = screen.getByRole("region", { name: "To Do" });
    await waitFor(() => expect(within(todo).queryByText("Plain")).toBeNull());
    expect(within(todo).getAllByText(/bug$/).map((e) => e.textContent)).toEqual(["Alpha bug", "Zed bug"]);
    const backlog = screen.getByRole("region", { name: "Backlog" });
    expect(within(backlog).queryByText("Backlog plain")).toBeNull();
  });

  it("filters every column by a saved search", async () => {
    saveBoardView({ ...EMPTY_VIEW, query: "login" });
    renderBoard([
      makeCard({ status: "ready", title: "Fix login" }),
      makeCard({ status: "ready", title: "Add export" }),
    ]);
    const todo = screen.getByRole("region", { name: "To Do" });
    await waitFor(() => expect(within(todo).queryByText("Add export")).toBeNull());
    expect(within(todo).getByText("Fix login")).toBeInTheDocument();
  });

  it("shows default views when the saved value is corrupt", () => {
    window.localStorage.setItem(BOARD_VIEW_KEY, "{nope");
    renderBoard([makeCard({ status: "ready", title: "Fix login" })]);
    expect(screen.getByText("Fix login")).toBeInTheDocument();
  });

  it("asks for archived cards when Archived is saved", async () => {
    saveBoardView({ ...EMPTY_VIEW, types: ["archived"] });
    const onArchivedWanted = vi.fn();
    renderBoard([makeCard()], { onArchivedWanted });
    await waitFor(() => expect(onArchivedWanted).toHaveBeenLastCalledWith(true));
  });
});

describe("Board, on a wide screen", () => {
  it("renders all five columns", () => {
    renderBoard([makeCard()]);
    for (const name of ["Backlog", "To Do", "In Progress", "In Review", "Done"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  it("starts new requests from Backlog and To Do, and nowhere else on a wide screen", async () => {
    const onNewItem = vi.fn();
    renderBoard([makeCard({ status: "draft" })], { onNewItem });

    const buttons = screen.getAllByRole("button", { name: "New request" });
    expect(buttons).toHaveLength(2);

    const backlog = screen.getByRole("region", { name: "Backlog" });
    const todo = screen.getByRole("region", { name: "To Do" });
    const backlogButton = buttons.find((b) => backlog.contains(b));
    const todoButton = buttons.find((b) => todo.contains(b));
    expect(backlogButton).toBeDefined();
    expect(todoButton).toBeDefined();

    const user = userEvent.setup();
    await user.click(backlogButton!);
    expect(onNewItem).toHaveBeenCalledWith("backlog");

    await user.click(todoButton!);
    expect(onNewItem).toHaveBeenCalledWith("todo");
  });

  it("sends a card on with its arrow: one typed transition", async () => {
    const card = makeCard({ key: "PROT-09", status: "draft" });
    const { onTransition } = renderBoard([card]);

    await userEvent.setup().click(
      screen.getByRole("button", { name: "Move PROT-09 to To Do" }),
    );

    expect(onTransition).toHaveBeenCalledOnce();
    expect(onTransition.mock.calls[0]![0]).toMatchObject({
      cardId: card.id,
      from: "backlog",
      to: "todo",
      actor: "user",
    });
  });

  it("gives no arrow to a card that could not take the step", () => {
    renderBoard([
      makeCard({ key: "PROT-10", status: "waiting" }),
      makeCard({ key: "PROT-11", status: "merged" }),
    ]);
    expect(screen.queryByRole("button", { name: /^Move PROT-10/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move PROT-11/ })).toBeNull();
  });

  it("gives a ready ticket its arrow into In Progress", () => {
    renderBoard([makeCard({ key: "PROT-12", status: "ready" })]);
    expect(
      screen.getByRole("button", { name: "Move PROT-12 to In Progress" }),
    ).toBeInTheDocument();
  });

  it("has no logo, sync badge, board options menu or app bar + button", () => {
    renderBoard([makeCard()]);
    expect(screen.queryByText("Formic")).toBeNull();
    expect(screen.queryByText(/synced|behind/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Board options" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New backlog item" })).toBeNull();
  });
});

describe("Board, ordering the Done column", () => {
  /*
   * Done's order is not the person's: it is derived from when each card
   * finished, so nothing in the column can be picked up to reorder it. The
   * assertions below pin that default — newest completed first — for
   * both the tickets standing alone and the epic groups Done shows.
   */
  it("orders the Done column by completion time, newest first, regardless of position", () => {
    const older = makeCard({ key: "PROT-20", status: "merged", position: 1000, mergedAt: "2025-01-01T10:00:00Z" });
    const newer = makeCard({ key: "PROT-21", status: "merged", position: 2000, mergedAt: "2025-01-02T10:00:00Z" });
    renderBoard([older, newer]);

    const done = screen.getByRole("region", { name: "Done" });
    expect(
      within(done)
        .getAllByText(/^PROT-\d+$/)
        .map((el) => el.textContent),
    ).toEqual(["PROT-21", "PROT-20"]);
  });

  it("orders Done's epic groups by completion time too, with their tickets nested beneath", () => {
    const [earlyEpic, ...earlyKids] = makeEpicWithChildren(
      { key: "EPIC-1", title: "Early epic", status: "merged", position: 1000, updatedAt: "2025-01-01T10:00:00Z" },
      [{ key: "PROT-30", status: "merged", mergedAt: "2025-01-01T09:00:00Z" }],
    );
    const [lateEpic, ...lateKids] = makeEpicWithChildren(
      { key: "EPIC-2", title: "Late epic", status: "merged", position: 2000, updatedAt: "2025-01-02T10:00:00Z" },
      [{ key: "PROT-31", status: "merged", mergedAt: "2025-01-02T09:00:00Z" }],
    );
    renderBoard([earlyEpic!, ...earlyKids, lateEpic!, ...lateKids]);

    const done = screen.getByRole("region", { name: "Done" });
    const groups = within(done).getAllByRole("listitem");
    expect(groups).toHaveLength(2);
    // The epic that finished later sits above, its own merged ticket nested.
    expect(groups[0]).toHaveTextContent("Late epic");
    expect(groups[0]).toHaveTextContent("PROT-31");
    expect(groups[1]).toHaveTextContent("Early epic");
    expect(groups[1]).toHaveTextContent("PROT-30");
  });

  it("renders an empty Done column without error", () => {
    renderBoard([makeCard({ status: "draft" })]);
    const done = screen.getByRole("region", { name: "Done" });
    expect(within(done).getByText("Nothing here.")).toBeInTheDocument();
  });

  it("keeps the drag handle on a card sitting in Done, so a mistaken merge can be dragged out", () => {
    const merged = makeCard({ key: "PROT-22", status: "merged", mergedAt: "2025-01-01T10:00:00Z" });
    renderBoard([merged]);

    // Done's order is derived (pinned above), but the card itself is still
    // picked up by hand: a move the rules do not allow lands with a warning
    // rather than being refused at the handle.
    const doneRegion = screen.getByRole("region", { name: "Done" });
    expect(
      doneRegion.querySelector(`[data-rfd-drag-handle-draggable-id="${merged.id}"]`),
    ).not.toBeNull();
  });
});

describe("Board, as the server moves cards", () => {
  it("shows a card where the server says it is now, not where it first rendered", () => {
    const card = makeCard({ key: "T-2", status: "draft" });
    const props = {
      projectName: "Formic",
      repoFullName: "formic-labs/formic-web",
      onOpenCard: vi.fn(),
      onNewItem: vi.fn(),
      onTransition: vi.fn(),
    };
    const { rerender } = render(<Board cards={[card]} {...props} />);
    const toDo = screen.getByRole("region", { name: "To Do" });
    expect(toDo).not.toHaveTextContent("T-2");

    // An Epic went back to To Do, and its parked ticket with it.
    rerender(<Board cards={[{ ...card, status: "ready" }]} {...props} />);
    expect(toDo).toHaveTextContent("T-2");
  });
});

describe("Board, below 768px", () => {
  it("shows one column at a time, with an indicator carrying the counts", async () => {
    setViewportMatches(true);
    const [epic, ...kids] = makeEpicWithChildren({ status: "ready" }, [
      { status: "ready" },
      { status: "waiting" },
    ]);
    renderBoard([makeCard({ status: "draft" }), epic!, ...kids]);

    const bar = await screen.findByRole("list", { name: "Columns" });
    expect(within(bar).getByRole("button", { name: "To Do 2" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: /^Backlog/ }).closest("li")).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("region", { name: "To Do" })).toBeNull();
  });

  it("switches to To Do when a Queen is picked up, on a phone only", async () => {
    const carry = () => act(() => void window.dispatchEvent(new CustomEvent("formic:queen-carry", { detail: { on: true } })));
    setViewportMatches(true);
    const phone = render(
      <Board cards={[makeCard({ status: "ready" })]} projectName="Formic" repoFullName="a/b" onOpenCard={vi.fn()} onNewItem={vi.fn()} onTransition={vi.fn()} />,
    );
    await screen.findByRole("region", { name: "Backlog" });
    carry();
    expect(await screen.findByRole("region", { name: "To Do" })).toBeInTheDocument();
    phone.unmount();

    setViewportMatches(false);
    renderBoard([makeCard({ status: "ready" })]);
    carry();
    expect(screen.getByRole("region", { name: "Backlog" })).toBeInTheDocument();
  });

  describe("tapping a column chip", () => {
    const chip = (name: RegExp) => within(screen.getByRole("list", { name: "Columns" })).getByRole("button", { name });
    const setup = async () => {
      setViewportMatches(true);
      renderBoard([makeCard({ status: "draft" })]);
      await screen.findByRole("region", { name: "Backlog" });
    };

    it("jumps to that column and marks its chip current", async () => {
      await setup();
      await userEvent.click(chip(/^Done/));
      expect(await screen.findByRole("region", { name: "Done" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Backlog" })).toBeNull();
      expect(chip(/^Done/).closest("li")).toHaveAttribute("aria-current", "true");
      expect(document.querySelector("[data-slide]")).toHaveAttribute("data-slide", "next");
    });

    it("slides in from the previous side when going back", async () => {
      await setup();
      await userEvent.click(chip(/^Done/));
      await userEvent.click(chip(/^Backlog/));
      expect(await screen.findByRole("region", { name: "Backlog" })).toBeInTheDocument();
      expect(document.querySelector("[data-slide]")).toHaveAttribute("data-slide", "previous");
    });

    it("does nothing when the active chip is tapped", async () => {
      await setup();
      await userEvent.click(chip(/^Backlog/));
      expect(screen.getByRole("region", { name: "Backlog" })).toBeInTheDocument();
      expect(document.querySelector("[data-slide]")).toBeNull();
    });
  });

  describe("swiping", () => {
    const swipe = (dx: number, dy = 0) => {
      const main = document.querySelector("main")!;
      fireEvent.touchStart(main, { touches: [{ clientX: 200, clientY: 300 }] });
      fireEvent.touchEnd(main, { changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
    };
    const setup = async () => {
      setViewportMatches(true);
      renderBoard([makeCard({ status: "draft" })]);
      await screen.findByRole("region", { name: "Backlog" });
    };

    it("moves to the next column on a left swipe and back on a right swipe", async () => {
      await setup();
      swipe(-100);
      expect(screen.getByRole("region", { name: "To Do" })).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Backlog" })).toBeNull();
      swipe(100);
      expect(screen.getByRole("region", { name: "Backlog" })).toBeInTheDocument();
    });

    it("marks the slide direction after a swipe, and not on first render", async () => {
      await setup();
      const slide = () => document.querySelector("[data-slide]");
      expect(slide()).toBeNull();
      swipe(-100);
      expect(slide()).toHaveAttribute("data-slide", "next");
      swipe(100);
      expect(slide()).toHaveAttribute("data-slide", "previous");
    });

    it("does not animate a swipe past the end", async () => {
      await setup();
      swipe(100);
      expect(document.querySelector("[data-slide]")).toBeNull();
    });

    it("stays put at Backlog and at Done", async () => {
      await setup();
      swipe(100);
      expect(screen.getByRole("region", { name: "Backlog" })).toBeInTheDocument();
      for (let i = 0; i < 6; i++) swipe(-100);
      expect(screen.getByRole("region", { name: "Done" })).toBeInTheDocument();
    });

    it("ignores a mostly vertical scroll with horizontal drift", async () => {
      await setup();
      swipe(-60, 150);
      expect(screen.getByRole("region", { name: "Backlog" })).toBeInTheDocument();
    });
  });

  it("has no floating Advance button; the card's own arrow takes it on", async () => {
    setViewportMatches(true);
    const card = makeCard({ key: "PROT-09", status: "draft" });
    const { onTransition } = renderBoard([card]);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move PROT-09 to To Do" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /^Advance/ })).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Move PROT-09 to To Do" }));
    expect(onTransition.mock.calls[0]![0]).toMatchObject({ cardId: card.id, from: "backlog", to: "todo" });
  });

  it("gives an In Progress ticket a left arrow back to To Do", async () => {
    setViewportMatches(true);
    const card = makeCard({ key: "PROT-13", status: "running" });
    const { onTransition } = renderBoard([card]);

    const user = userEvent.setup();
    await screen.findByRole("region", { name: "Backlog" });
    const main = document.querySelector("main")!;
    for (let i = 0; i < 2; i++) {
      fireEvent.touchStart(main, { touches: [{ clientX: 200, clientY: 300 }] });
      fireEvent.touchEnd(main, { changedTouches: [{ clientX: 100, clientY: 300 }] });
    }
    await user.click(screen.getByRole("button", { name: "Return PROT-13 to To Do" }));

    expect(onTransition).toHaveBeenCalledOnce();
    expect(onTransition.mock.calls[0]![0]).toMatchObject({
      cardId: card.id,
      from: "in_progress",
      to: "todo",
      actor: "user",
    });
  });

  it("gives no return arrow on a wide screen", () => {
    renderBoard([makeCard({ key: "PROT-14", status: "running" })]);
    expect(screen.queryByRole("button", { name: /^Return/ })).toBeNull();
  });

  it("hovers a moved card in its destination column until the server answers", async () => {
    let answer!: (r: TransitionResult) => void;
    const onTransition = vi.fn(() => new Promise<TransitionResult>((res) => (answer = res)));
    renderBoard([makeCard({ key: "PROT-09", status: "draft" })], { onTransition });

    await userEvent.setup().click(screen.getByRole("button", { name: "Move PROT-09 to To Do" }));

    const todo = screen.getByRole("region", { name: "To Do" });
    expect(todo.querySelector("[data-pending]")).not.toBeNull();
    await act(async () => answer({ ok: true, status: "ready", runId: null }));
    expect(document.querySelector("[data-pending]")).toBeNull();
  });

  it("lets go of the hover when the move is refused", async () => {
    let answer!: (r: TransitionResult) => void;
    const onTransition = vi.fn(() => new Promise<TransitionResult>((res) => (answer = res)));
    renderBoard([makeCard({ key: "PROT-09", status: "draft" })], { onTransition });

    await userEvent.setup().click(screen.getByRole("button", { name: "Move PROT-09 to To Do" }));
    expect(document.querySelector("[data-pending]")).not.toBeNull();
    await act(async () => answer({ ok: false, reason: "No.", revertTo: "backlog" }));
    expect(document.querySelector("[data-pending]")).toBeNull();
  });

  it("puts the card back and says why when the server refuses", async () => {
    setViewportMatches(true);
    const onTransition = vi.fn(
      async (): Promise<TransitionResult> => ({
        ok: false,
        reason: "That epic has no PRD yet.",
        revertTo: "backlog",
      }),
    );
    renderBoard([makeCard({ key: "PROT-09", status: "draft" })], { onTransition });

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move PROT-09 to To Do" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Move PROT-09 to To Do" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That epic has no PRD yet.",
    );
    // Still in Backlog: the optimistic move was dropped, not kept.
    const bar = screen.getByRole("list", { name: "Columns" });
    expect(within(bar).getByText("Backlog")).toHaveTextContent("Backlog 1");
    expect(within(bar).getByText("To Do")).toHaveTextContent("To Do 0");
  });
});

describe("Board archived filter", () => {
  it("shows archived cards in Done once Archived is toggled on, and asks for them", async () => {
    const onArchivedWanted = vi.fn();
    const live = makeCard({ status: "merged", title: "Shipped one" });
    const old = makeCard({ status: "merged", title: "Old archived", archived: true });
    renderBoard([live, old], { onArchivedWanted });
    expect(screen.queryByText("Old archived")).not.toBeInTheDocument();

    const user = userEvent.setup();
    const done = screen.getByRole("region", { name: /done/i });
    await user.click(within(done).getByRole("button", { name: "Column options" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Archived" }));

    expect(screen.getByText("Old archived")).toBeInTheDocument();
    expect(screen.queryByText("Shipped one")).not.toBeInTheDocument();
    expect(onArchivedWanted).toHaveBeenLastCalledWith(true);
  });
});

describe("Board, an arrow move on a phone", () => {
  /** Answers each media query on its own: phone width, and reduced motion or not. */
  const stubMedia = (reduced: boolean, phone = true) => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("reduced-motion") ? reduced : phone,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  };

  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const tap = async () => {
    const arrow = await screen.findByRole("button", { name: "Move PROT-09 to To Do" });
    fireEvent.click(arrow);
    return arrow;
  };

  it("sends the move only after the card has slid out, and once for a double tap", async () => {
    stubMedia(false);
    const { onTransition } = renderBoard([makeCard({ key: "PROT-09", status: "draft" })]);
    const arrow = await tap();

    expect(onTransition).not.toHaveBeenCalled();
    expect(arrow.closest("li")!.firstElementChild).toHaveClass("translate-x-full");
    fireEvent.click(arrow);
    act(() => void vi.advanceTimersByTime(250));
    expect(onTransition).toHaveBeenCalledOnce();
  });

  it("sends the move at once with reduced motion", async () => {
    stubMedia(true);
    const { onTransition } = renderBoard([makeCard({ key: "PROT-09", status: "draft" })]);
    await tap();
    expect(onTransition).toHaveBeenCalledOnce();
  });

  it("sends the move at once on a wide screen", async () => {
    stubMedia(false, false);
    const { onTransition } = renderBoard([makeCard({ key: "PROT-09", status: "draft" })]);
    await tap();
    expect(onTransition).toHaveBeenCalledOnce();
  });
});
