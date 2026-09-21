"use client";

import { useCallback, useMemo, useState } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { Column } from "./column";
import { BoardHeader } from "./header";
import type { CardExtras } from "./card";
import type { BoardCard } from "@/lib/domain/entities";
import {
  COLUMNS,
  COLUMN_LABELS,
  type ColumnId,
  canUserMove,
  columnFor,
} from "@/lib/domain/status";
import type { CardTransition, TransitionResult } from "@/lib/domain/transitions";
import { byPosition, positionForIndex } from "@/lib/ordering";
import { useMediaQuery } from "@/lib/hooks/use-media-query";

/** The next column a card can advance to, for the mobile action. */
const NEXT_COLUMN: Partial<Record<ColumnId, ColumnId>> = {
  backlog: "todo",
  todo: "in_progress",
};

export interface BoardProps {
  cards: BoardCard[];
  extras?: Record<string, CardExtras | undefined>;
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  inSync?: boolean;
  onOpenCard: (card: BoardCard) => void;
  onNewItem: () => void;
  /**
   * The single trigger. Returns the server's verdict; a rejection rolls the
   * card back to where it came from.
   */
  onTransition: (t: CardTransition) => Promise<TransitionResult>;
}

export function Board({
  cards,
  extras = {},
  projectName,
  repoFullName,
  baseBranch,
  inSync = true,
  onOpenCard,
  onNewItem,
  onTransition,
}: BoardProps) {
  const [optimistic, setOptimistic] = useState<BoardCard[]>(cards);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ColumnId>("backlog");

  const isMobile = useMediaQuery("(max-width: 767px)");

  // Server state wins whenever it changes; optimistic state only bridges the
  // gap between a drop and its response.
  const live = useMemo(() => {
    const pending = new Map(optimistic.map((c) => [c.id, c]));
    return cards.map((c) => pending.get(c.id) ?? c);
  }, [cards, optimistic]);

  const byColumn = useMemo(() => {
    const out: Record<ColumnId, BoardCard[]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    for (const card of live) {
      out[columnFor(card.status, card.stalledIn)].push(card);
    }
    for (const col of COLUMNS) out[col].sort(byPosition);
    return out;
  }, [live]);

  const epics = live.filter((c) => c.kind === "epic");
  const epicsDone = epics.filter((c) => c.status === "merged").length;

  const commit = useCallback(
    async (card: BoardCard, to: ColumnId, index: number) => {
      const from = columnFor(card.status, card.stalledIn);
      const verdict = canUserMove(from, to);
      if (!verdict.ok) {
        setError(verdict.reason);
        return;
      }

      const destination = byColumn[to].filter((c) => c.id !== card.id);
      const position = positionForIndex(
        destination.map((c) => c.position),
        index,
      );

      setError(null);
      setOptimistic((prev) => [
        ...prev.filter((c) => c.id !== card.id),
        { ...card, position, stalledIn: to === from ? card.stalledIn : null },
      ]);

      const result = await onTransition({
        cardId: card.id,
        kind: card.kind,
        from,
        to,
        position,
        actor: "user",
      });

      if (!result.ok) {
        // Drop the optimistic entry and surface why. The card snaps back
        // because `live` falls through to server state.
        setOptimistic((prev) => prev.filter((c) => c.id !== card.id));
        setError(result.reason);
        return;
      }

      setOptimistic((prev) => prev.filter((c) => c.id !== card.id));
    },
    [byColumn, onTransition],
  );

  const onDragEnd = useCallback(
    (result: DropResult) => {
      const { source, destination, draggableId } = result;
      if (!destination) return;
      if (
        destination.droppableId === source.droppableId &&
        destination.index === source.index
      ) {
        return;
      }
      const card = live.find((c) => c.id === draggableId);
      if (!card) return;
      void commit(card, destination.droppableId as ColumnId, destination.index);
    },
    [commit, live],
  );

  const advance = useCallback(
    (card: BoardCard) => {
      const from = columnFor(card.status, card.stalledIn);
      const to = NEXT_COLUMN[from];
      if (!to) return;
      void commit(card, to, byColumn[to].length);
    },
    [byColumn, commit],
  );

  const visibleColumns = isMobile ? [activeTab] : COLUMNS;

  return (
    <div className="flex min-h-dvh flex-col">
      <BoardHeader
        projectName={projectName}
        repoFullName={repoFullName}
        baseBranch={baseBranch}
        inSync={inSync}
        epicsTotal={epics.length}
        epicsDone={epicsDone}
        onNewItem={onNewItem}
      />

      {/* Mobile column tabs. Replaces the 5-column layout below 768px. */}
      <nav
        className="border-line bg-surface sticky top-[41px] z-20 flex gap-0.5 overflow-x-auto border-b px-1 py-1 md:hidden"
        aria-label="Columns"
      >
        {COLUMNS.map((col) => (
          <button
            key={col}
            type="button"
            onClick={() => setActiveTab(col)}
            aria-current={activeTab === col}
            className={cn(
              "rounded px-1.5 py-1 text-[12px] font-medium whitespace-nowrap transition-colors",
              activeTab === col
                ? "bg-amber text-on-amber"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {COLUMN_LABELS[col]}
            <span className="ml-1 font-mono text-[10px] tabular-nums opacity-70">
              {byColumn[col].length}
            </span>
          </button>
        ))}
      </nav>

      {error && (
        <div
          role="alert"
          className="border-crimson bg-crimson/10 text-crimson-text mx-2 mt-1 rounded border px-2 py-1 text-[12px]"
        >
          {error}
        </div>
      )}

      <DragDropContext onDragEnd={onDragEnd}>
        <main
          className={cn(
            "min-h-0 flex-1 gap-2 p-2 pb-12",
            isMobile ? "flex flex-col" : "grid grid-cols-5",
          )}
        >
          {visibleColumns.map((col) => (
            <Column
              key={col}
              id={col}
              cards={byColumn[col]}
              extras={extras}
              onOpen={onOpenCard}
              onAdvance={advance}
              advanceLabel={
                NEXT_COLUMN[col] ? `Advance to ${COLUMN_LABELS[NEXT_COLUMN[col]!]}` : null
              }
              showAdvance={isMobile}
            />
          ))}
        </main>
      </DragDropContext>
    </div>
  );
}
