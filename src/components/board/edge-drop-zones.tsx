"use client";

import { Droppable } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";
import { adjacentColumn, type SwipeDirection } from "./swipe";

/** The `droppableId`s the board's `onDragEnd` matches to move a card a column over. */
export const EDGE_NEXT_ID = "edge-next";
export const EDGE_PREVIOUS_ID = "edge-previous";

const EDGE_DIRECTION: Record<string, SwipeDirection> = {
  [EDGE_NEXT_ID]: "next",
  [EDGE_PREVIOUS_ID]: "previous",
};

/** The column an edge zone stands for, seen from `from`; null when `id` is not an edge zone. */
export function edgeDestination(id: string, from: ColumnId): ColumnId | null {
  const direction = EDGE_DIRECTION[id];
  return direction ? adjacentColumn(from, direction) : null;
}

/**
 * The columns a card dragged out of `from` may be dropped towards: none where
 * there is no neighbour (Backlog has no previous, Done no next) or where
 * `accepts` refuses the move. `home` is where the card works, which `accepts`
 * judges the move from.
 */
export function edgeTargets(
  from: ColumnId,
  home: ColumnId,
  accepts: (from: ColumnId, to: ColumnId) => boolean,
): { next: ColumnId | null; previous: ColumnId | null } {
  const offer = (direction: SwipeDirection) => {
    const to = adjacentColumn(from, direction);
    return to !== from && accepts(home, to) ? to : null;
  };
  return { next: offer("next"), previous: offer("previous") };
}

/**
 * The mobile board shows one column, so there is no other column to drop on.
 * These two Droppables stand for its neighbours: the right edge is the next
 * column, the left edge the previous one. They are mounted all the while
 * (the library cannot register a Droppable mid-drag) and inert until
 * `dragging`. A side with no target is not offered.
 *
 * The Droppable itself is only as wide as the board's padding, so a card at
 * rest does not overlap it and a card pushed off the screen's edge does; the
 * visible overlay is wider, to be seen and aimed at.
 */
export function EdgeDropZones({
  dragging,
  next,
  previous,
}: {
  dragging: boolean;
  next: ColumnId | null;
  previous: ColumnId | null;
}) {
  return (
    <>
      <EdgeZone id={EDGE_NEXT_ID} side="right" target={next} dragging={dragging} />
      <EdgeZone id={EDGE_PREVIOUS_ID} side="left" target={previous} dragging={dragging} />
    </>
  );
}

function EdgeZone({
  id,
  side,
  target,
  dragging,
}: {
  id: string;
  side: "left" | "right";
  target: ColumnId | null;
  dragging: boolean;
}) {
  const revealed = dragging && !!target;
  return (
    <Droppable droppableId={id} isDropDisabled={!target}>
      {(provided, snapshot) => (
        <section
          ref={provided.innerRef}
          {...provided.droppableProps}
          aria-label={target ? `Move to ${COLUMN_LABELS[target]}` : undefined}
          className={cn(
            "pointer-events-none absolute inset-y-0 z-10 w-4",
            side === "left" ? "left-0" : "right-0",
            revealed && "pointer-events-auto",
          )}
        >
          <div
            data-hidden={!revealed || undefined}
            data-over={snapshot.isDraggingOver || undefined}
            aria-hidden={!revealed || undefined}
            className={cn(
              "bg-cream absolute inset-y-0 flex w-[72px] items-center justify-center px-1 text-center text-xs font-medium transition-[opacity,colors] duration-200 motion-reduce:transition-none",
              side === "left" ? "left-0 border-r-2 border-dashed" : "right-0 border-l-2 border-dashed",
              revealed ? "opacity-100" : "opacity-0",
              snapshot.isDraggingOver
                ? "border-terracotta bg-terracotta/10 text-terracotta"
                : "border-clay/40 text-clay",
            )}
          >
            {target && COLUMN_LABELS[target]}
          </div>
          <div className="hidden">{provided.placeholder}</div>
        </section>
      )}
    </Droppable>
  );
}
