"use client";

import { useCallback, useMemo, useState } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { Column, columnCount } from "./column";
import { BoardHeader } from "./header";
import { BacklogComposer } from "./composer";
import type { ExtrasMap } from "./card";
import type { AgentPreset, BoardCard, ColumnAgents } from "@/lib/domain/entities";
import type { Account } from "./account-menu";
import type { AssistantControls } from "./assistant";
import {
  COLUMNS,
  COLUMN_LABELS,
  type ColumnId,
  canUserMove,
  columnFor,
  isDraggable,
} from "@/lib/domain/status";
import type { CardTransition, TransitionResult } from "@/lib/domain/transitions";
import { byPosition } from "@/lib/ordering";
import { placeDrop } from "./placement";
import { useMediaQuery } from "@/lib/hooks/use-media-query";

/** The next column a card can advance to, for the mobile action. */
const NEXT_COLUMN: Partial<Record<ColumnId, ColumnId>> = {
  backlog: "todo",
  todo: "in_progress",
};

export interface BoardProps {
  cards: BoardCard[];
  extras?: ExtrasMap;
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  inSync?: boolean;
  syncedLabel?: string;
  onOpenCard: (card: BoardCard) => void;
  onShowcase?: (epic: BoardCard) => void;
  onNewItem: () => void;
  /** Backlog's inline composer. Same destination as the header CTA. */
  onCapture: (rawRequest: string) => Promise<void>;
  /**
   * The single trigger. Returns the server's verdict; a rejection rolls the
   * card back to where it came from.
   */
  onTransition: (t: CardTransition) => Promise<TransitionResult>;
  /** Who is signed in, for the header's account menu. */
  account?: Account;
  /** The board's assistant, in the header. */
  assistant?: AssistantControls;
  /** Per-column agent choice. Omitted, columns show no agent selector. */
  agents?: {
    presets: AgentPreset[];
    columns: ColumnAgents;
    onAssign: (column: ColumnId, presetId: string | null) => Promise<void>;
    onEdit: (column: ColumnId, preset: AgentPreset | null) => void;
  };
}

export function Board({
  cards,
  extras = {},
  projectName,
  repoFullName,
  baseBranch,
  inSync = true,
  syncedLabel,
  onOpenCard,
  onShowcase,
  onNewItem,
  onCapture,
  onTransition,
  agents,
  account,
  assistant,
}: BoardProps) {
  const [optimistic, setOptimistic] = useState<BoardCard[]>(cards);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ColumnId>("backlog");
  const [collapsed, setCollapsed] = useState<Record<ColumnId, Set<string>>>(
    () => ({
      backlog: new Set(),
      todo: new Set(),
      in_progress: new Set(),
      in_review: new Set(),
      done: new Set(),
    }),
  );

  const toggleCollapse = useCallback((column: ColumnId, epicId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev[column]);
      if (!next.delete(epicId)) next.add(epicId);
      return { ...prev, [column]: next };
    });
  }, []);

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

  /** `index` is the drag library's: among the destination's rendered rows. */
  const commit = useCallback(
    async (card: BoardCard, to: ColumnId, index: number) => {
      const from = columnFor(card.status, card.stalledIn);
      const verdict = canUserMove(from, to);
      if (!verdict.ok) {
        setError(verdict.reason);
        return;
      }

      const { position, detached } = placeDrop({
        card,
        destination: byColumn[to],
        column: to,
        collapsed: collapsed[to],
        index,
      });

      setError(null);
      setOptimistic((prev) => [
        ...prev.filter((c) => c.id !== card.id),
        {
          ...card,
          position,
          detached,
          stalledIn: to === from ? card.stalledIn : null,
        },
      ]);

      const result = await onTransition({
        cardId: card.id,
        kind: card.kind,
        from,
        to,
        position,
        detached: card.kind === "ticket" ? detached : undefined,
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
    [byColumn, collapsed, onTransition],
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

  /*
   * Mobile advance. @hello-pangea/dnd does not survive a touch scroll
   * container, so small screens get an explicit action instead of a worse
   * version of the same gesture. It acts on the first card in the visible
   * column that can actually move, and says which one in its accessible name.
   */
  const advanceTarget = useMemo(() => {
    const to = NEXT_COLUMN[activeTab];
    if (!to) return null;
    const card = byColumn[activeTab].find((c) => isDraggable(c.status));
    return card ? { card, to } : null;
  }, [activeTab, byColumn]);

  const visibleColumns = isMobile ? [activeTab] : COLUMNS;

  return (
    <>
      <BoardHeader
        projectName={projectName}
        repoFullName={repoFullName}
        baseBranch={baseBranch}
        inSync={inSync}
        syncedLabel={syncedLabel}
        epicsTotal={epics.length}
        epicsDone={epicsDone}
        onNewItem={onNewItem}
        account={account}
        assistant={assistant}
      />

      {/* Sticky column tabs. Replaces the 5-column layout below 768px. */}
      <nav
        aria-label="Columns"
        className="border-line bg-cream flex h-13 shrink-0 items-center gap-2 overflow-x-auto border-b px-4 md:hidden"
      >
        {COLUMNS.map((col) => {
          const active = activeTab === col;
          return (
            <button
              key={col}
              type="button"
              onClick={() => setActiveTab(col)}
              aria-current={active ? "true" : undefined}
              className="inline-flex h-11 shrink-0 items-center"
            >
              <span
                className={cn(
                  "inline-flex h-9 items-center rounded-full text-[13px] whitespace-nowrap",
                  active
                    ? "bg-anthracite text-cream px-3.5 font-semibold"
                    : "border-line bg-card text-muted border px-3 font-medium",
                )}
              >
                {COLUMN_LABELS[col]}{" "}
                <span className="ml-1 tabular-nums">
                  {columnCount(byColumn[col], col)}
                </span>
              </span>
            </button>
          );
        })}
      </nav>

      {error && (
        <div
          role="alert"
          className="bg-crimson/12 text-ink mx-4 mt-2 shrink-0 rounded-md px-2 py-1.5 text-[12px] md:mx-6"
        >
          {error}
        </div>
      )}

      <DragDropContext onDragEnd={onDragEnd}>
        <main
          className={cn(
            "relative flex min-h-0 flex-1",
            isMobile ? "flex-col gap-3 p-4" : "gap-4 p-6",
          )}
        >
          {visibleColumns.map((col) => (
            <Column
              key={col}
              id={col}
              cards={byColumn[col]}
              extras={extras}
              bare={isMobile}
              collapsed={collapsed[col]}
              onToggleCollapse={(epicId) => toggleCollapse(col, epicId)}
              agent={
                agents && {
                  presets: agents.presets,
                  selected: agents.presets.find((p) => p.id === agents.columns[col]),
                  onAssign: (presetId) => agents.onAssign(col, presetId),
                  onEdit: (preset) => agents.onEdit(col, preset),
                }
              }
              composer={
                col === "backlog" ? (
                  <BacklogComposer onSubmit={onCapture} />
                ) : undefined
              }
              onOpen={onOpenCard}
              onShowcase={onShowcase}
            />
          ))}

          {isMobile && advanceTarget && (
            <button
              type="button"
              onClick={() =>
                void commit(
                  advanceTarget.card,
                  advanceTarget.to,
                  // Past the last row: the end of the column.
                  Number.MAX_SAFE_INTEGER,
                )
              }
              aria-label={`Advance ${advanceTarget.card.key} to ${COLUMN_LABELS[advanceTarget.to]}`}
              className="bg-terracotta-cta fixed right-4 bottom-[72px] z-30 inline-flex h-13 items-center gap-2 rounded-[26px] px-5 text-[14px] font-semibold text-white shadow-fab"
            >
              Advance card
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3.5 8h9M9 4.5 12.5 8 9 11.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </main>
      </DragDropContext>
    </>
  );
}
