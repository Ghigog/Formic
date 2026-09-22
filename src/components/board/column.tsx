"use client";

import { useMemo, useState } from "react";
import { Droppable } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { CoinBadge } from "@/components/ui/coin-badge";
import { EpicGroup, KanbanCard, type ExtrasMap } from "./card";
import type { BoardCard } from "@/lib/domain/entities";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";

/** The one-word description of what happens to a card while it sits here. */
export const COLUMN_HINT: Record<ColumnId, string> = {
  backlog: "Ideation",
  todo: "Decomposition",
  in_progress: "Execution",
  in_review: "CI & merge",
  done: "Showcase ready",
};

/** The header dot. Only In Progress breathes: it is the only live column. */
const COLUMN_DOT: Record<ColumnId, { color: string; live: boolean }> = {
  backlog: { color: "bg-idle", live: false },
  todo: { color: "bg-clay", live: false },
  in_progress: { color: "bg-terracotta", live: true },
  in_review: { color: "bg-rust", live: false },
  done: { color: "bg-jade", live: false },
};

/**
 * To Do shows the DAG and Done shows the merged set, so in both an epic
 * absorbs the tickets it owns in that column. Elsewhere a ticket stands on
 * its own, which is what the artboard shows for a card mid-flight.
 */
const GROUPS_CHILDREN: Record<ColumnId, boolean> = {
  backlog: false,
  todo: true,
  in_progress: false,
  in_review: false,
  done: true,
};

type RenderItem =
  | { kind: "card"; card: BoardCard }
  | { kind: "group"; epic: BoardCard; children: BoardCard[] };

/** Column order with each epic's own tickets folded in behind it. */
function layout(cards: BoardCard[], grouped: boolean): RenderItem[] {
  if (!grouped) return cards.map((card) => ({ kind: "card" as const, card }));

  const epicIds = new Set(
    cards.filter((c) => c.kind === "epic").map((c) => c.id),
  );
  const adopted = new Set(
    cards
      .filter((c) => c.kind !== "epic" && c.epicId && epicIds.has(c.epicId))
      .map((c) => c.id),
  );

  const items: RenderItem[] = [];
  for (const card of cards) {
    if (adopted.has(card.id)) continue;
    if (card.kind === "epic") {
      items.push({
        kind: "group",
        epic: card,
        children: cards.filter((c) => adopted.has(c.id) && c.epicId === card.id),
      });
    } else {
      items.push({ kind: "card", card });
    }
  }
  return items;
}

/**
 * The count in a column header and on its mobile tab: work items, not render
 * nodes. An epic that has absorbed tickets here counts as those tickets; an
 * epic with none of its own in this column counts as itself.
 */
export function columnCount(cards: BoardCard[], id: ColumnId): number {
  return layout(cards, GROUPS_CHILDREN[id]).reduce(
    (n, item) =>
      n + (item.kind === "card" ? 1 : Math.max(1, item.children.length)),
    0,
  );
}

export function Column({
  id,
  cards,
  extras,
  composer,
  bare = false,
  onOpen,
  onShowcase,
  className,
}: {
  id: ColumnId;
  cards: BoardCard[];
  extras: ExtrasMap;
  /**
   * Mobile: one column at a time, with the tab bar already carrying the label
   * and the count, so the well and its header would only be chrome.
   */
  bare?: boolean;
  /** Backlog leads with an inline composer; the other columns pass nothing. */
  composer?: React.ReactNode;
  onOpen: (card: BoardCard) => void;
  onShowcase?: (epic: BoardCard) => void;
  className?: string;
}) {
  const dot = COLUMN_DOT[id];
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const items = useMemo(() => layout(cards, GROUPS_CHILDREN[id]), [cards, id]);

  const count = items.reduce(
    (n, item) =>
      n + (item.kind === "card" ? 1 : Math.max(1, item.children.length)),
    0,
  );

  /*
   * Drag indices have to run 0..n-1 over exactly what is rendered, so they are
   * allotted here rather than inside the group: a collapsed epic contributes
   * one index, an expanded one contributes itself plus a child each.
   */
  let next = 0;
  const rendered = items.map((item) => {
    if (item.kind === "card") return { item, index: next++, shown: [] as BoardCard[] };
    const index = next++;
    const isCollapsed = collapsed.has(item.epic.id);
    const shown = isCollapsed ? [] : item.children;
    next += shown.length;
    return { item, index, shown, isCollapsed };
  });

  const toggle = (epicId: string) =>
    setCollapsed((prev) => {
      const out = new Set(prev);
      if (!out.delete(epicId)) out.add(epicId);
      return out;
    });

  return (
    <section
      aria-label={COLUMN_LABELS[id]}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col gap-2.5",
        !bare && "bg-column border-column-line rounded-xl border p-3",
        className,
      )}
    >
      {!bare && (
      <div className="flex items-center gap-2 px-0.5">
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full", dot.color, dot.live && "pulse-dot")}
        />
        <h2 className="text-ink text-[11px] font-semibold tracking-[0.1em] uppercase">
          {COLUMN_LABELS[id]}
        </h2>
        <CoinBadge
          ground="cream"
          title={`${count} cards`}
          className="text-[10px] tabular-nums"
        >
          {String(count).padStart(2, "0")}
        </CoinBadge>
        <div className="flex-grow" />
        <span className="text-muted text-[10px] font-medium">
          {COLUMN_HINT[id]}
        </span>
      </div>
      )}

      {composer}

      <Droppable droppableId={id}>
        {(provided, snapshot) => (
          <ul
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "flex min-h-16 flex-1 flex-col overflow-x-hidden overflow-y-auto rounded-lg transition-colors [&>li:not(:last-child)]:mb-2.5",
              snapshot.isDraggingOver && "bg-clay/8",
            )}
          >
            {rendered.map(({ item, index, shown, isCollapsed }) =>
              item.kind === "card" ? (
                <KanbanCard
                  key={item.card.id}
                  card={item.card}
                  column={id}
                  index={index}
                  extras={extras}
                  onOpen={onOpen}
                />
              ) : (
                <EpicGroup
                  key={item.epic.id}
                  epic={item.epic}
                  tickets={shown}
                  column={id}
                  index={index}
                  extras={extras}
                  collapsed={isCollapsed ?? false}
                  onToggle={() => toggle(item.epic.id)}
                  onOpen={onOpen}
                  onShowcase={onShowcase}
                />
              ),
            )}
            {provided.placeholder}
            {items.length === 0 && !snapshot.isDraggingOver && (
              <li className="text-muted px-0.5 py-2 text-[11px]">Nothing here.</li>
            )}
          </ul>
        )}
      </Droppable>
    </section>
  );
}
