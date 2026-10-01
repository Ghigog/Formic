import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { DropResult, ResponderProvided } from "@hello-pangea/dnd";
import { Board } from "./board";
import { makeCard } from "@/test/cards";

/**
 * The board's side of archiving: the ghost is taken when the card is dropped
 * on the archive zone, and the flight plays only once the zone reports the
 * archive done. jsdom cannot drag, so the drop context hands its onDragEnd to
 * the test, and the zone is a stub whose button is "the archive succeeded".
 */
const dnd = vi.hoisted(() => ({
  onDragEnd: null as null | ((r: DropResult, p: ResponderProvided) => void),
}));

vi.mock("@hello-pangea/dnd", async (orig) => {
  const actual = await orig<typeof import("@hello-pangea/dnd")>();
  return {
    ...actual,
    DragDropContext: (
      p: React.ComponentProps<typeof actual.DragDropContext>,
    ) => {
      dnd.onDragEnd = p.onDragEnd;
      return <actual.DragDropContext {...p} />;
    },
  };
});

vi.mock("./archive-drop-zone", () => ({
  ARCHIVE_DROPPABLE_ID: "archive",
  ArchiveDropZone: (p: {
    dropped?: { ticketId: string } | null;
    onArchived: (id: string) => void;
  }) => (
    <button
      disabled={!p.dropped}
      onClick={() => p.onArchived(p.dropped!.ticketId)}
    >
      archive succeeded
    </button>
  ),
}));

const flyToNest = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/components/colony/archive-flight", () => ({ flyToNest }));

const colony = vi.hoisted(() => ({
  current: null as null | { sfx: () => void; fx: { reducedMotion: boolean } },
}));
vi.mock("@/components/colony/colony", () => ({
  useColony: () => colony.current,
}));

// The header's stats read a whole colony; this test only needs the board's use of it.
vi.mock("@/components/colony/header-stats", () => ({
  ColonyHeaderStats: () => null,
  ColonyLevelStats: () => null,
  ColonyMobileStats: () => null,
}));

const card = makeCard({ status: "ready", title: "Fix login" });

function renderBoard(onArchived = vi.fn()) {
  render(
    <Board
      cards={[card]}
      projectName="Formic"
      repoFullName="formic-labs/formic-web"
      onOpenCard={vi.fn()}
      onNewItem={vi.fn()}
      onTransition={vi.fn()}
      onArchived={onArchived}
    />,
  );
  return onArchived;
}

function dropOnArchive() {
  act(() =>
    dnd.onDragEnd!(
      {
        draggableId: card.id,
        type: "DEFAULT",
        reason: "DROP",
        mode: "FLUID",
        source: { droppableId: "ready", index: 0 },
        destination: { droppableId: "archive", index: 0 },
        combine: null,
      },
      { announce: () => {} },
    ),
  );
}

describe("Board archive flight", () => {
  beforeEach(() => {
    flyToNest.mockClear();
    colony.current = { sfx: vi.fn(), fx: { reducedMotion: false } };
  });

  it("plays the flight once, before onArchived, when the archive succeeds", () => {
    const order: string[] = [];
    flyToNest.mockImplementation(async () => void order.push("fly"));
    const onArchived = renderBoard(vi.fn(() => order.push("archived")));
    dropOnArchive();
    expect(flyToNest).not.toHaveBeenCalled();
    act(() =>
      screen.getByRole("button", { name: "archive succeeded" }).click(),
    );
    expect(flyToNest).toHaveBeenCalledTimes(1);
    expect(onArchived).toHaveBeenCalledWith(card.id);
    expect(order).toEqual(["fly", "archived"]);
  });

  it("plays nothing when the archive fails", () => {
    const onArchived = renderBoard();
    dropOnArchive();
    expect(flyToNest).not.toHaveBeenCalled();
    expect(onArchived).not.toHaveBeenCalled();
  });

  it("still archives with no colony", () => {
    colony.current = null;
    const onArchived = renderBoard();
    dropOnArchive();
    act(() =>
      screen.getByRole("button", { name: "archive succeeded" }).click(),
    );
    expect(flyToNest).not.toHaveBeenCalled();
    expect(onArchived).toHaveBeenCalledWith(card.id);
  });
});
