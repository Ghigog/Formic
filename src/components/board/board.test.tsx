import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board, type BoardProps } from "./board";
import { makeCard, makeEpicWithChildren } from "@/test/cards";
import { setViewportMatches } from "@/test/viewport";
import type { BoardCard } from "@/lib/domain/entities";
import type { ArchiveDropResult, TransitionResult } from "@/lib/domain/transitions";

/**
 * A real drag needs real layout, which jsdom does not have (see
 * src/test/setup-dom.ts) — fine for the column tests above, since a real
 * `Droppable`/`Draggable` still renders its children and the data attributes
 * those tests assert on. Testing what Board itself decides once a drag is
 * under way — which composer turns into the Archive zone, what a drop there
 * does — needs `onDragStart`/`onDragUpdate`/`onDragEnd` to actually fire,
 * which only a real gesture can trigger. So here alone, the library is
 * replaced with a stand-in that renders exactly what the real one does
 * (children get `provided`/`snapshot`, nothing wraps them) but hands the
 * three callbacks Board wires to `<DragDropContext>` to the test, which
 * calls them directly to play out a drag without needing real coordinates.
 */
const dnd = vi.hoisted(() => ({
  handlers: {} as {
    onDragStart?: (start: unknown) => void;
    onDragUpdate?: (update: unknown) => void;
    onDragEnd?: (result: unknown) => void;
  },
}));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({
    children,
    onDragStart,
    onDragUpdate,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragStart?: (start: unknown) => void;
    onDragUpdate?: (update: unknown) => void;
    onDragEnd?: (result: unknown) => void;
  }) => {
    dnd.handlers = { onDragStart, onDragUpdate, onDragEnd };
    return children;
  },
  Droppable: ({
    children,
  }: {
    children: (provided: unknown, snapshot: unknown) => React.ReactNode;
  }) =>
    children(
      { innerRef: () => {}, droppableProps: {}, placeholder: null },
      { isDraggingOver: false, draggingOverWith: null },
    ),
  Draggable: ({
    children,
  }: {
    children: (provided: unknown, snapshot: unknown) => React.ReactNode;
  }) =>
    children(
      { innerRef: () => {}, draggableProps: {}, dragHandleProps: {} },
      { isDragging: false },
    ),
}));

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
): { onTransition: ReturnType<typeof vi.fn>; onArchive: ReturnType<typeof vi.fn> } {
  const onTransition = vi.fn(
    async (): Promise<TransitionResult> => ({ ok: true, status: "ready", runId: null }),
  );
  const onArchive = vi.fn(async (): Promise<ArchiveDropResult> => ({ ok: true }));

  render(
    <Board
      cards={cards}
      projectName="Formic"
      repoFullName="formic-labs/formic-web"
      baseBranch="main"
      onOpenCard={vi.fn()}
      onNewItem={vi.fn()}
      onTransition={onTransition}
      onArchive={onArchive}
      {...overrides}
    />,
  );

  return { onTransition, onArchive };
}

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
      onArchive: vi.fn(),
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

  /*
   * The artboard's floating button does not say which card it moves. Naming
   * the card in the accessible name is the one addition: an action that moves
   * "something" is not an action anybody can trust.
   */
  it("names the card the floating action will move", async () => {
    setViewportMatches(true);
    renderBoard([makeCard({ key: "PROT-09", status: "draft" })]);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Advance PROT-09 to To Do" }),
      ).toBeInTheDocument(),
    );
  });

  it("offers no advance where nothing in the column can move", async () => {
    setViewportMatches(true);
    renderBoard([makeCard({ status: "merged" })]);

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Done 1" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Done 1" }));

    expect(screen.queryByRole("button", { name: /^Advance/ })).toBeNull();
  });

  it("emits one typed transition when a card advances", async () => {
    setViewportMatches(true);
    const card = makeCard({ key: "PROT-09", status: "draft" });
    const { onTransition } = renderBoard([card]);

    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Advance/ })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^Advance/ }));

    expect(onTransition).toHaveBeenCalledOnce();
    expect(onTransition.mock.calls[0]![0]).toMatchObject({
      cardId: card.id,
      kind: "ticket",
      from: "backlog",
      to: "todo",
      actor: "user",
    });
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
      expect(screen.getByRole("button", { name: /^Advance/ })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^Advance/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That epic has no PRD yet.",
    );
    // Still in Backlog: the optimistic move was dropped, not kept.
    expect(screen.getByRole("button", { name: "Backlog 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "To Do 0" })).toBeInTheDocument();
  });
});

describe("Board, dragging a ticket onto the Archive zone", () => {
  function start(draggableId: string, droppableId = "backlog") {
    act(() => {
      dnd.handlers.onDragStart?.({
        draggableId,
        type: "DEFAULT",
        mode: "FLUID",
        source: { droppableId, index: 0 },
      });
    });
  }

  function drop(
    draggableId: string,
    destination: { droppableId: string; index: number } | null,
    source: { droppableId: string; index: number } = { droppableId: "backlog", index: 0 },
  ) {
    act(() => {
      dnd.handlers.onDragEnd?.({
        draggableId,
        type: "DEFAULT",
        reason: "DROP",
        mode: "FLUID",
        source,
        destination,
        combine: null,
      });
    });
  }

  it("turns both New request buttons into the Archive zone for a ticket drag, and back once it ends without a drop", () => {
    const card = makeCard({ key: "PROT-20", status: "draft" });
    renderBoard([card]);

    expect(screen.getAllByRole("button", { name: "New request" })).toHaveLength(2);

    start(card.id);
    expect(screen.queryByRole("button", { name: "New request" })).toBeNull();
    expect(screen.getAllByText("Archive")).toHaveLength(2);

    drop(card.id, null);
    expect(screen.getAllByRole("button", { name: "New request" })).toHaveLength(2);
    expect(screen.queryByText("Archive")).toBeNull();
  });

  it("does not offer the Archive zone while dragging an Epic", () => {
    const [epic] = makeEpicWithChildren({ status: "specified" }, []);
    renderBoard([epic!]);

    start(epic!.id);
    expect(screen.getAllByRole("button", { name: "New request" })).toHaveLength(2);
    expect(screen.queryByText("Archive")).toBeNull();
  });

  it("closes a ticket dropped on the Archive zone and removes it from the board", async () => {
    // Never resolves: this only checks the optimistic removal, the same way
    // commit()'s own tests above never simulate the refetch that follows a
    // real transition either.
    const onArchive = vi.fn(() => new Promise<ArchiveDropResult>(() => {}));
    const card = makeCard({ key: "PROT-21", status: "draft" });
    renderBoard([card], { onArchive });

    expect(screen.getByText("PROT-21")).toBeInTheDocument();

    start(card.id);
    drop(card.id, { droppableId: "archive:backlog", index: 0 });

    await waitFor(() => expect(onArchive).toHaveBeenCalledWith(card.id));
    expect(screen.queryByText("PROT-21")).toBeNull();
  });

  it("keeps a rejected ticket where it was, with the server's reason", async () => {
    const card = makeCard({ key: "PROT-22", status: "queued" });
    const onArchive = vi.fn(
      async (): Promise<ArchiveDropResult> => ({
        ok: false,
        reason: "An agent is still working this ticket. Stop its run first, then archive it.",
      }),
    );
    renderBoard([card], { onArchive });

    start(card.id, "in_progress");
    drop(
      card.id,
      { droppableId: "archive:backlog", index: 0 },
      { droppableId: "in_progress", index: 0 },
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An agent is still working this ticket. Stop its run first, then archive it.",
    );
    expect(screen.getByText("PROT-22")).toBeInTheDocument();
  });
});
