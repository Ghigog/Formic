"use client";

import { useEffect, useState } from "react";
import { Droppable } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";

/** The `droppableId` the board's `onDragEnd` matches to route a drop here. */
export const ARCHIVE_DROPPABLE_ID = "archive";

/**
 * A drop target along the bottom of the board. The board's `onDragEnd` sees a
 * drop on `ARCHIVE_DROPPABLE_ID` and hands the ticket id down as `dropped`;
 * this archives it, then tells the board through `onArchived`. On failure the
 * board is left alone, so the ticket stays where it was.
 *
 * `dropped` is an object so that dropping the same ticket again after a
 * failure is a new value and retries.
 */
export function ArchiveDropZone({
  dropped,
  onArchived,
}: {
  dropped?: { ticketId: string } | null;
  onArchived: (ticketId: string) => void;
}) {
  // The settled outcome of one drop. A drop with no outcome yet is in flight,
  // so loading is derived rather than set from inside the effect.
  const [outcome, setOutcome] = useState<{
    drop: object;
    error: string | null;
  } | null>(null);
  const archiving = !!dropped && outcome?.drop !== dropped;
  const error = outcome && outcome.drop === dropped ? outcome.error : null;

  useEffect(() => {
    if (!dropped) return;
    const { ticketId } = dropped;
    let live = true;
    fetch(`/api/tickets/${ticketId}/archive`, { method: "PATCH" })
      .then((res) => {
        if (!res.ok) throw new Error(`Archive failed (${res.status})`);
        if (!live) return;
        setOutcome({ drop: dropped, error: null });
        onArchived(ticketId);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setOutcome({
          drop: dropped,
          error: err instanceof Error ? err.message : "Archive failed",
        });
      });
    return () => {
      live = false;
    };
    // `onArchived` is deliberately not a dependency: a new callback identity
    // must not re-archive the same drop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  return (
    <Droppable droppableId={ARCHIVE_DROPPABLE_ID}>
      {(provided, snapshot) => (
        <section
          ref={provided.innerRef}
          {...provided.droppableProps}
          aria-label="Archive"
          data-over={snapshot.isDraggingOver || undefined}
          className={cn(
            "flex shrink-0 items-center justify-center gap-2 border-t-2 border-dashed px-4 py-3 text-sm font-medium transition-colors",
            snapshot.isDraggingOver
              ? "border-terracotta bg-terracotta/10 text-terracotta"
              : "border-clay/40 text-clay",
          )}
        >
          <span>
            {snapshot.isDraggingOver
              ? "Drop to archive"
              : archiving
                ? "Archiving…"
                : "Archive"}
          </span>
          {error && (
            <span role="alert" className="text-log-error">
              {error}
            </span>
          )}
          <div className="hidden">{provided.placeholder}</div>
        </section>
      )}
    </Droppable>
  );
}
