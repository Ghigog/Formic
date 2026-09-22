"use client";

import { Draggable } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { CoinBadge } from "@/components/ui/coin-badge";
import { StatusPill } from "@/components/ui/status-pill";
import { ProgressBar } from "@/components/ui/progress-bar";
import { AGENT_ROLE_LABELS, type BoardCard } from "@/lib/domain/entities";
import { isDraggable } from "@/lib/domain/status";

export interface CardExtras {
  ci?: "pending" | "passing" | "failing";
  progress?: { label: string; fraction: number | null };
}

function shortModel(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function KanbanCard({
  card,
  index,
  extras,
  onOpen,
  onAdvance,
  advanceLabel,
  showAdvance,
}: {
  card: BoardCard;
  index: number;
  extras?: CardExtras;
  onOpen: (card: BoardCard) => void;
  onAdvance?: (card: BoardCard) => void;
  advanceLabel?: string | null;
  showAdvance: boolean;
}) {
  const draggable = isDraggable(card.status);
  const running = card.status === "running";
  const isEpic = card.kind === "epic";

  return (
    <Draggable draggableId={card.id} index={index} isDragDisabled={!draggable}>
      {(provided, snapshot) => (
        <li
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={cn(
            "p-card bg-surface border-line rounded-card border",
            "focus-within:border-amber transition-shadow",
            draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default",
            snapshot.isDragging && "border-amber shadow-lg",
            running && "animate-agent-pulse",
            isEpic && "border-l-amber border-l-2",
          )}
        >
          <div className="flex items-start gap-1">
            <button
              type="button"
              onClick={() => onOpen(card)}
              className="min-w-0 flex-1 text-left"
            >
              <span className="text-fg-subtle font-mono text-[10px] tracking-tight">
                {card.key}
              </span>
              <h3
                className={cn(
                  "text-fg mt-0.5 text-[13px] leading-5 font-medium",
                  isEpic && "font-serif text-[14px]",
                )}
              >
                {card.title}
              </h3>
            </button>

            <div className="flex shrink-0 flex-col items-end gap-1">
              {card.size && <CoinBadge title="Ticket size">{card.size}</CoinBadge>}
              {card.model && (
                <CoinBadge tone="ochre" title="Model">
                  {shortModel(card.model)}
                </CoinBadge>
              )}
            </div>
          </div>

          {isEpic && card.childCount > 0 && (
            <p className="text-fg-subtle mt-1 text-[11px]">
              {card.doneCount} of {card.childCount} tickets merged
            </p>
          )}

          {extras?.progress && (
            <ProgressBar
              className="mt-1.5"
              tone="ochre"
              value={extras.progress.fraction}
              label={extras.progress.label}
            />
          )}
          {extras?.progress && (
            <p className="text-ochre-text mt-0.5 font-mono text-[10px]">
              {extras.progress.label}
            </p>
          )}

          {card.blockedReason && (
            <p className="text-crimson-text mt-1 text-[11px] leading-4">
              {card.blockedReason}
            </p>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusPill status={card.status} />

            {card.agentRole && (
              <span className="text-fg-subtle text-[11px]">
                {AGENT_ROLE_LABELS[card.agentRole]} agent
              </span>
            )}

            {card.prNumber && (
              <a
                href={card.prUrl ?? "#"}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-fg-muted hover:text-amber-text font-mono text-[10px] underline-offset-2 hover:underline"
              >
                #{card.prNumber}
              </a>
            )}

            {extras?.ci && (
              <CoinBadge
                tone={
                  extras.ci === "passing"
                    ? "jade"
                    : extras.ci === "failing"
                      ? "crimson"
                      : "neutral"
                }
                filled={extras.ci !== "pending"}
                title="CI status"
              >
                CI
              </CoinBadge>
            )}

            {card.costCents > 0 && (
              <span className="text-fg-subtle ml-auto font-mono text-[10px] tabular-nums">
                ${(card.costCents / 100).toFixed(2)}
              </span>
            )}
          </div>

          {card.fileScope.length > 0 && (
            <p
              className="text-fg-subtle mt-1 truncate font-mono text-[10px]"
              title={card.fileScope.join(", ")}
            >
              {card.fileScope.join(" · ")}
            </p>
          )}

          {/*
            Mobile advance. Drag and drop does not survive a touch scroll
            container, so small screens get an explicit action instead of a
            worse version of the same gesture.
          */}
          {showAdvance && advanceLabel && onAdvance && draggable && (
            <button
              type="button"
              onClick={() => onAdvance(card)}
              className="border-amber text-amber-text hover:bg-amber hover:text-on-amber mt-1.5 w-full rounded border py-1 text-[11px] font-medium transition-colors"
            >
              {advanceLabel}
            </button>
          )}
        </li>
      )}
    </Draggable>
  );
}
