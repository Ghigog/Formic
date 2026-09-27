"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  DragDropContext,
  type DragStart,
  type DragUpdate,
  type DropResult,
} from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { useCountdown } from "@/lib/hooks/use-countdown";
import { Column, columnCount } from "./column";
import { BoardHeader } from "./header";
import { CardEnvContext, type CardEnv, type ExtrasMap } from "./card";
import { useColony } from "@/components/colony/colony";
import type { AgentPreset, BoardCard, ColumnAgents } from "@/lib/domain/entities";
import type { Account } from "./account-menu";
import type { AssistantControls } from "./assistant";
import {
  COLUMNS,
  COLUMN_LABELS,
  type ColumnId,
  canUserMove,
  columnFor,
  columnOf,
  statusForUserDrop,
} from "@/lib/domain/status";
import type { CardTransition, TransitionResult } from "@/lib/domain/transitions";
import { byPosition } from "@/lib/ordering";
import { runningConflict } from "@/lib/domain/queue";
import { placeDrop } from "./placement";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import type { CaptureColumn } from "./new-item-dialog";

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
  /** Opens the capture dialog: a column's "New request" button, and the mobile CTA. */
  onNewItem: (column: CaptureColumn) => void;
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
  onTransition,
  agents,
  account,
  assistant,
}: BoardProps) {
  // Empty until a drop. Seeded with the cards, it pinned every card to how it
  // first rendered, so nothing the server said about it afterwards showed.
  const [optimistic, setOptimistic] = useState<BoardCard[]>([]);
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

  const isMobile = useMediaQuery("(max-width: 767px)");
  const colony = useColony();

  const toggleCollapse = useCallback(
    (column: ColumnId, epicId: string) => {
      colony?.sfx(collapsed[column].has(epicId) ? "unfold" : "fold");
      setCollapsed((prev) => {
        const next = new Set(prev[column]);
        if (!next.delete(epicId)) next.add(epicId);
        return { ...prev, [column]: next };
      });
    },
    [collapsed, colony],
  );
  /** The column under a dragged card, for its sounds. Not state: a drag must not re-render the board. */
  const dragOver = useRef<ColumnId | null>(null);
  /**
   * The columns as last rendered before a drag began, held until it ends.
   * Agents stream status and progress over SSE while they work, and a tick
   * arriving mid-drag re-renders the board even though nothing about the
   * dragged card changed. @hello-pangea/dnd cannot survive a re-render of its
   * subtree mid-gesture: at best it drops the gesture (`onDragEnd` sees no
   * destination), at worst — if the event actually moves the dragged card to
   * a different column — its `<Draggable>` unmounts while the library still
   * has it pinned to the pointer with `position: fixed`, so the card the user
   * is holding vanishes outright. Freezing the rendered columns to this
   * snapshot for the life of the drag keeps any such update from touching
   * that subtree until the gesture is over.
   */
  const [dragSnapshot, setDragSnapshot] = useState<React.ReactNode[] | null>(null);

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
      out[columnOf(card)].push(card);
    }
    for (const col of COLUMNS) out[col].sort(byPosition);
    return out;
  }, [live]);

  /** `index` is the drag library's: among the destination's rendered rows. */
  const commit = useCallback(
    async (card: BoardCard, to: ColumnId, index: number) => {
      const from = columnOf(card);
      // Any drop is sent: one the rules do not allow still lands, and the
      // server says what is wrong with it. This only guesses the status it
      // lands in, so it renders in the right column until the answer.
      const home = columnFor(card.status, card.stalledIn);
      const fits = to === from || to === home || canUserMove(home, to).ok;

      const { position, detached } = placeDrop({
        card,
        destination: byColumn[to],
        column: to,
        collapsed: collapsed[to],
        index,
      });

      setError(null);
      // The status the server will give it, so the card renders in the
      // column it was dropped in: the column is derived from status, and the
      // old one sent it straight back until the server answered.
      const depsMet = card.dependsOn.every(
        (id) => live.find((c) => c.id === id)?.status === "merged",
      );
      // Onto files another agent is writing, it queues behind that one.
      const queues = card.kind === "ticket" && to === "in_progress" && !!runningConflict(card, live);
      const moved: BoardCard =
        fits
          ? {
              ...card,
              status:
                to === from || to === home
                  ? card.status
                  : queues
                    ? "queued"
                    : statusForUserDrop(to, depsMet),
              position,
              detached,
              stalledIn: to === from || to === home ? card.stalledIn : null,
              misplacedIn: to === from ? card.misplacedIn : null,
              misplacedReason: to === from ? card.misplacedReason : null,
            }
          : { ...card, position, detached, misplacedIn: to };
      setOptimistic((prev) => [...prev.filter((c) => c.id !== card.id), moved]);
      // Only this drop's own entry: a second drop of the same card, made while
      // this one was in flight, has replaced it and must not be undone by it.
      const settle = () => setOptimistic((prev) => prev.filter((c) => c !== moved));

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
        settle();
        setError(result.reason);
        // After the card has snapped back, so the flash lands on it. The
        // full reason is in the banner above and the card's "!"; the flash
        // itself just needs to say something went wrong.
        requestAnimationFrame(() => colony?.reject(card.id, "Error"));
        return;
      }

      settle();
      if (result.problem) {
        // It stays where it was put; the "!" on it keeps saying why.
        setError(result.problem);
        requestAnimationFrame(() => colony?.reject(card.id, "Needs you"));
      }
    },
    [byColumn, collapsed, live, onTransition, colony],
  );

  /** Whether a column would take a card dragged out of `from`. */
  const accepts = useCallback(
    (from: ColumnId, to: ColumnId) => {
      if (from === to) return true;
      if (!canUserMove(from, to).ok) return false;
      const until = agents?.presets.find((p) => p.id === agents.columns[to])?.limitedUntil;
      return !until || new Date(until).getTime() <= Date.now();
    },
    [agents],
  );

  const visibleColumns = isMobile ? [activeTab] : COLUMNS;

  const columnElements = visibleColumns.map((col) => (
    <Column
      key={col}
      id={col}
      cards={byColumn[col]}
      extras={extras}
      bare={isMobile}
      collapsed={collapsed[col]}
      accepts={(cardId) => {
        const card = live.find((c) => c.id === cardId);
        // Where it can work: its own column, or a move the rules allow
        // from there. Anywhere else still takes it, with a warning.
        return (
          !card ||
          col === columnOf(card) ||
          accepts(columnFor(card.status, card.stalledIn), col)
        );
      }}
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
        col === "backlog" || col === "todo" ? (
          <NewRequestButton onClick={() => onNewItem(col)} />
        ) : undefined
      }
      onOpen={onOpenCard}
      onShowcase={onShowcase}
    />
  ));

  const onDragStart = useCallback(
    (start: DragStart) => {
      dragOver.current = start.source.droppableId as ColumnId;
      colony?.sfx("pickup");
      setDragSnapshot(columnElements);
    },
    [colony, columnElements],
  );

  const onDragUpdate = useCallback(
    (update: DragUpdate) => {
      const over = (update.destination?.droppableId as ColumnId | undefined) ?? null;
      if (over === dragOver.current) return;
      dragOver.current = over;
      const from = update.source.droppableId as ColumnId;
      if (over && over !== from) colony?.sfx(accepts(from, over) ? "hover" : "deny");
    },
    [accepts, colony],
  );

  const onDragEnd = useCallback(
    (result: DropResult) => {
      dragOver.current = null;
      setDragSnapshot(null);
      const { source, destination, draggableId } = result;
      if (!destination) {
        colony?.sfx("drop");
        return;
      }
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
    [commit, live, colony],
  );

  const epicsById = useMemo(
    () => new Map(live.filter((c) => c.kind === "epic").map((c) => [c.id, c])),
    [live],
  );

  /*
   * A card's arrow: the one step forward a person may take it. Backlog to
   * To Do for anything, To Do to In Progress for a ticket that is ready,
   * and never into a column whose agent is out of usage.
   */
  const cardEnv = useMemo<CardEnv>(
    () => ({
      epics: epicsById,
      nextFor: (card, column) => {
        const to = NEXT_COLUMN[column];
        if (!to || card.misplacedIn || card.status === "running" || card.status === "review") {
          return null;
        }
        if (to === "in_progress" && (card.kind !== "ticket" || card.status !== "ready")) return null;
        return accepts(column, to) ? to : null;
      },
      onAdvance: (card, to) => void commit(card, to, Number.MAX_SAFE_INTEGER),
      queuedBehind: (card) => runningConflict(card, live),
    }),
    [epicsById, accepts, commit, live],
  );

  /*
   * Mobile advance. @hello-pangea/dnd does not survive a touch scroll
   * container, so small screens get an explicit action instead of a worse
   * version of the same gesture. It acts on the first card in the visible
   * column that can actually move, and says which one in its accessible name.
   */
  // A column whose agent is out of usage takes nothing until it resets.
  const nextColumn = NEXT_COLUMN[activeTab];
  const nextLimited =
    useCountdown(
      nextColumn && agents?.presets.find((p) => p.id === agents.columns[nextColumn])?.limitedUntil,
    ) !== null;
  const advanceTarget = useMemo(() => {
    const to = NEXT_COLUMN[activeTab];
    if (!to || nextLimited) return null;
    const card = byColumn[activeTab].find(
      (c) => !c.misplacedIn && c.status !== "running" && c.status !== "review",
    );
    return card ? { card, to } : null;
  }, [activeTab, byColumn, nextLimited]);

  return (
    <>
      <BoardHeader
        projectName={projectName}
        repoFullName={repoFullName}
        baseBranch={baseBranch}
        inSync={inSync}
        syncedLabel={syncedLabel}
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

      <CardEnvContext.Provider value={cardEnv}>
      <DragDropContext onDragStart={onDragStart} onDragUpdate={onDragUpdate} onDragEnd={onDragEnd}>
        <main
          data-colony="board"
          className={cn(
            "relative flex min-h-0 flex-1",
            isMobile ? "flex-col gap-3 p-4" : "gap-4 p-6",
          )}
        >
          {dragSnapshot ?? columnElements}

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
              className="bg-terracotta-cta fixed right-4 bottom-[72px] z-50 inline-flex h-13 items-center gap-2 rounded-[26px] px-5 text-[14px] font-semibold text-white shadow-fab"
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
      </CardEnvContext.Provider>
    </>
  );
}

/** The head of the Backlog: where a new request starts. */
function NewRequestButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-card border-line-dashed text-muted hover:border-terracotta hover:text-ink flex h-10 shrink-0 items-center gap-2 rounded-lg border border-dashed px-3 text-[12px] font-medium transition-colors active:scale-[0.98]"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      New request
    </button>
  );
}
