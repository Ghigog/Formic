"use client";

import { useMemo, useState } from "react";
import { Droppable } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { CoinBadge } from "@/components/ui/coin-badge";
import { EpicGroup, KanbanCard, type ExtrasMap } from "./card";
import type { BoardCard } from "@/lib/domain/entities";
import { COLUMN_LABELS, type ColumnId } from "@/lib/domain/status";
import { layout } from "./placement";
import { AgentSelect, type ColumnAgentControls } from "./agent-select";
import { formatCountdown, useCountdown } from "@/lib/hooks/use-countdown";

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
 * The count in a column header and on its mobile tab: work items, not render
 * nodes. An epic that has absorbed tickets here counts as those tickets; an
 * epic with none of its own in this column counts as itself.
 */
export function columnCount(cards: BoardCard[], id: ColumnId): number {
  return layout(cards, id).reduce(
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
  collapsed: controlledCollapsed,
  onToggleCollapse,
  accepts,
  agent,
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
  /**
   * Which epics are folded shut. The board owns this when it needs to place
   * drops, since a collapsed accordion changes what a drag index points at.
   */
  collapsed?: ReadonlySet<string>;
  onToggleCollapse?: (epicId: string) => void;
  /**
   * Whether this column would take the card being dragged. Drawn as a dashed
   * edge under the pointer: terracotta for yes, crimson for no.
   */
  accepts?: (cardId: string) => boolean;
  /** Which agent works this column, and the controls to change it. */
  agent?: ColumnAgentControls;
  onOpen: (card: BoardCard) => void;
  onShowcase?: (epic: BoardCard) => void;
  className?: string;
}) {
  const dot = COLUMN_DOT[id];
  // The column's agent is out of usage on its plan: nothing can land here
  // until it resets. Picking another agent lifts it at once.
  const limitedFor = useCountdown(agent?.selected?.limitedUntil);
  const limited = limitedFor !== null;
  const [ownCollapsed, setOwnCollapsed] = useState<Set<string>>(new Set());
  const collapsed = controlledCollapsed ?? ownCollapsed;

  const items = useMemo(() => layout(cards, id), [cards, id]);

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
  const rendered: Array<{
    item: (typeof items)[number];
    index: number;
    shown: BoardCard[];
    isCollapsed?: boolean;
  }> = [];
  let next = 0;
  for (const item of items) {
    if (item.kind === "card") {
      rendered.push({ item, index: next++, shown: [] });
      continue;
    }
    const isCollapsed = collapsed.has(item.epic.id);
    const shown = isCollapsed ? [] : item.children;
    rendered.push({ item, index: next, shown, isCollapsed });
    next += 1 + shown.length;
  }

  const toggle = (epicId: string) =>
    onToggleCollapse
      ? onToggleCollapse(epicId)
      : setOwnCollapsed((prev) => {
          const out = new Set(prev);
          if (!out.delete(epicId)) out.add(epicId);
          return out;
        });

  return (
    <section
      aria-label={COLUMN_LABELS[id]}
      data-limited={limited || undefined}
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

      {limited && agent?.selected && (
        <LimitBanner
          agentName={agent.selected.name}
          until={agent.selected.limitedUntil!}
          left={limitedFor}
          note={agent.selected.limitNote}
          onClear={() => agent.onClearLimit(agent.selected!.id)}
        />
      )}

      {agent && <AgentSelect column={id} {...agent} />}

      {composer}

      <Droppable droppableId={id}>
        {(provided, snapshot) => (
          <ul
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              // Room around the cards for their lift, tilt and ants.
              "scroll-area -mx-2 flex min-h-16 flex-1 flex-col overflow-x-hidden rounded-lg px-2 pt-1.5 pb-3 transition-colors [&>li:not(:last-child)]:mb-2",
              snapshot.isDraggingOver &&
                (snapshot.draggingOverWith && accepts && !accepts(snapshot.draggingOverWith)
                  ? "bg-crimson/5 outline-crimson outline-[1.5px] -outline-offset-[1.5px] outline-dashed"
                  : "bg-terracotta/6 outline-terracotta outline-[1.5px] -outline-offset-[1.5px] outline-dashed"),
              limited && "opacity-50 grayscale",
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
              <li className="border-line-dashed text-muted flex h-[72px] shrink-0 items-center justify-center rounded-lg border border-dashed text-[11px]">
                Nothing here.
              </li>
            )}
          </ul>
        )}
      </Droppable>
    </section>
  );
}

/**
 * The front of a column whose agent is out of usage: when it can work
 * again, counting down, and what the agent said.
 */
function LimitBanner({
  agentName,
  until,
  left,
  note,
  onClear,
}: {
  agentName: string;
  until: string;
  left: number;
  note: string | null;
  /** For a mark that is stale or was set on the wrong agent. */
  onClear: () => void;
}) {
  const at = new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div
      role="status"
      title={note ?? undefined}
      className="border-line bg-card flex items-center gap-2 rounded-md border px-2 py-1.5"
    >
      <span aria-hidden className="bg-idle size-1.5 shrink-0 rounded-full" />
      <span className="text-muted min-w-0 flex-1 truncate text-[11px]">
        {agentName} is out of usage · back at {at}
      </span>
      <span
        aria-label={`Available in ${formatCountdown(left)}`}
        className="text-ink shrink-0 font-mono text-[11px] font-semibold tabular-nums"
      >
        {formatCountdown(left)}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="text-muted hover:text-ink shrink-0 text-[10px] underline decoration-dotted underline-offset-2"
      >
        Wrong? Clear
      </button>
    </div>
  );
}
