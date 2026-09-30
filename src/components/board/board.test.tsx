import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board, type BoardProps } from "./board";
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
      baseBranch="main"
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
      baseBranch: "main",
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

  /*
   * Both headers are in the DOM at once — the wide one and the app bar — and
   * CSS hides whichever does not apply. A real browser drops the hidden one
   * from the accessibility tree; jsdom loads no CSS, so it sees both. Only
   * the app bar carries the CTA now: on a wide screen, Backlog has its own.
   */
  it("routes the app bar's CTA to the capture dialog", async () => {
    const onNewItem = vi.fn();
    renderBoard([makeCard()], { onNewItem });

    const ctas = screen.getAllByRole("button", { name: "New backlog item" });
    expect(ctas).toHaveLength(1);

    await userEvent.setup().click(ctas[0]!);
    expect(onNewItem).toHaveBeenCalledWith("backlog");
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
      baseBranch: "main",
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
  it("shows one column at a time, with the tab bar carrying the counts", async () => {
    setViewportMatches(true);
    const [epic, ...kids] = makeEpicWithChildren({ status: "ready" }, [
      { status: "ready" },
      { status: "waiting" },
    ]);
    renderBoard([makeCard({ status: "draft" }), epic!, ...kids]);

    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Backlog/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "To Do 2" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "To Do" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "To Do 2" }));
    expect(screen.getByRole("region", { name: "To Do" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Backlog" })).toBeNull();
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
    await user.click(await screen.findByRole("button", { name: /^In Progress/ }));
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
    expect(screen.getByRole("button", { name: "Backlog 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "To Do 0" })).toBeInTheDocument();
  });
});
