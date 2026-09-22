"use client";

import { Droppable } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { KanbanCard, type CardExtras } from "./card";
import type { BoardCard } from "@/lib/domain/entities";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";

export const COLUMN_HINT: Record<ColumnId, string> = {
  backlog: "Ideation",
  todo: "Decomposition",
  in_progress: "Execution",
  in_review: "CI & Merge",
  done: "Showcase ready",
};

export function Column({
  id,
  cards,
  extras,
  onOpen,
  onAdvance,
  advanceLabel,
  showAdvance,
  className,
}: {
  id: ColumnId;
  cards: BoardCard[];
  extras: Record<string, CardExtras | undefined>;
  onOpen: (card: BoardCard) => void;
  onAdvance?: (card: BoardCard) => void;
  advanceLabel?: string | null;
  showAdvance: boolean;
  className?: string;
}) {
  return (
    <section
      className={cn("flex min-h-0 flex-col", className)}
      aria-label={COLUMN_LABELS[id]}
    >
      <header className="mb-1.5 flex items-baseline gap-1 px-0.5">
        <h2 className="text-fg text-[13px] font-semibold">
          {COLUMN_LABELS[id]}
        </h2>
        <span className="text-fg-subtle font-mono text-[10px] tabular-nums">
          {cards.length}
        </span>
        <span className="text-fg-subtle ml-auto hidden text-[10px] lg:inline">
          {COLUMN_HINT[id]}
        </span>
      </header>

      <Droppable droppableId={id}>
        {(provided, snapshot) => (
          <ul
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "flex min-h-24 flex-1 flex-col gap-1 rounded-card p-1 transition-colors",
              "overflow-y-auto",
              snapshot.isDraggingOver ? "bg-ochre/10" : "bg-sunken",
            )}
          >
            {cards.map((card, i) => (
              <KanbanCard
                key={card.id}
                card={card}
                index={i}
                extras={extras[card.id]}
                onOpen={onOpen}
                onAdvance={onAdvance}
                advanceLabel={advanceLabel}
                showAdvance={showAdvance}
              />
            ))}
            {provided.placeholder}
            {cards.length === 0 && !snapshot.isDraggingOver && (
              <li className="text-fg-subtle px-1 py-2 text-[11px]">Empty</li>
            )}
          </ul>
        )}
      </Droppable>
    </section>
  );
}
