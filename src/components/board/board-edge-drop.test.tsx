import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DragStart, DropResult, ResponderProvided } from "@hello-pangea/dnd";
import { Board } from "./board";
import { makeCard } from "@/test/cards";
import { setViewportMatches } from "@/test/viewport";

/**
 * The board's side of dragging to the edges on a phone. jsdom cannot drag, so
 * the drop context hands its responders to the test.
 */
const dnd = vi.hoisted(() => ({
  onDragStart: null as null | ((s: DragStart, p: ResponderProvided) => void),
  onDragEnd: null as null | ((r: DropResult, p: ResponderProvided) => void),
}));

vi.mock("@hello-pangea/dnd", async (orig) => {
  const actual = await orig<typeof import("@hello-pangea/dnd")>();
  return {
    ...actual,
    DragDropContext: (p: React.ComponentProps<typeof actual.DragDropContext>) => {
      dnd.onDragStart = p.onDragStart ?? null;
      dnd.onDragEnd = p.onDragEnd;
      return <actual.DragDropContext {...p} />;
    },
  };
});

vi.mock("@/components/colony/header-stats", () => ({
  ColonyHeaderStats: () => null,
  ColonyLevelStats: () => null,
  ColonyMobileStats: () => null,
}));

const ticket = makeCard({ kind: "ticket", status: "ready", title: "Fix login" });
const announce = { announce: () => {} };

function renderBoard(cards = [ticket]) {
  const onTransition = vi.fn(async () => ({ ok: true as const, status: "ready" as const, runId: null }));
  render(
    <Board
      cards={cards}
      projectName="Formic"
      repoFullName="formic-labs/formic-web"
      onOpenCard={vi.fn()}
      onNewItem={vi.fn()}
      onTransition={onTransition}
    />,
  );
  return onTransition;
}

const startDrag = (id = ticket.id, column = "todo") =>
  act(() =>
    dnd.onDragStart!(
      { draggableId: id, type: "DEFAULT", mode: "FLUID", source: { droppableId: column, index: 0 } },
      announce,
    ),
  );

const drop = (droppableId: string | null, id = ticket.id, column = "todo") =>
  act(() =>
    dnd.onDragEnd!(
      {
        draggableId: id,
        type: "DEFAULT",
        reason: "DROP",
        mode: "FLUID",
        source: { droppableId: column, index: 0 },
        destination: droppableId ? { droppableId, index: 0 } : null,
        combine: null,
      },
      announce,
    ),
  );

describe("Board, dragging to the edges on a phone", () => {
  beforeEach(() => {
    setViewportMatches(true);
    vi.useRealTimers();
  });

  it("moves a ticket dropped on the right edge to the next column", () => {
    const onTransition = renderBoard();
    startDrag();
    drop("edge-next");
    expect(onTransition).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: ticket.id, from: "todo", to: "in_progress" }),
    );
  });

  it("moves a ticket dropped on the left edge to the previous column", () => {
    const onTransition = renderBoard();
    startDrag();
    drop("edge-previous");
    expect(onTransition).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: ticket.id, from: "todo", to: "backlog" }),
    );
  });

  it("offers the neighbours' names while dragging", () => {
    renderBoard();
    startDrag();
    expect(screen.getByRole("region", { name: "Move to In Progress" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Move to Backlog" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Archive" })).toBeInTheDocument();
  });

  it("moves nothing when dropped away from every zone", () => {
    const onTransition = renderBoard();
    startDrag();
    drop(null);
    expect(onTransition).not.toHaveBeenCalled();
  });

  it("does not change the tab on the touchend that ends a drag", () => {
    renderBoard();
    const main = document.querySelector("main")!;
    startDrag();
    fireEvent.touchStart(main, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchEnd(main, { changedTouches: [{ clientX: 50, clientY: 100 }] });
    drop("edge-next");
    fireEvent.touchEnd(main, { changedTouches: [{ clientX: 50, clientY: 100 }] });
    expect(screen.getByText("Backlog", { selector: "p" })).toBeInTheDocument();
  });
});
