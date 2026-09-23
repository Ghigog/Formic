"use client";

import { Draggable } from "@hello-pangea/dnd";
import { cn } from "@/components/ui/cn";
import { CoinBadge } from "@/components/ui/coin-badge";
import { StatusChip } from "@/components/ui/status-pill";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ColumnTrail } from "@/components/ui/pheromone-trail";
import {
  STAGE_COUNT,
  type AgentRole,
  type BoardCard,
} from "@/lib/domain/entities";
import { isDraggable, type ColumnId } from "@/lib/domain/status";

/**
 * Display-only detail that hangs off a card but is not part of the domain
 * model: what the agent is doing right now, what CI said, what the merge
 * commit was. Live values arrive on the event stream; the demo board seeds
 * them from fixtures.
 */
export interface CardExtras {
  ci?: "pending" | "passing" | "failing";
  progress?: { label: string; fraction: number | null };
  /** One-line summary under a backlog epic's title. */
  summary?: string;
  /** Stage caption beside the eight stage pips, e.g. "PRD draft". */
  stageLabel?: string;
  /** Caption under a To Do epic, e.g. "DAG ready · 4 tickets". */
  dagSummary?: string;
  /** How long a raw idea has been sitting, e.g. "2h ago". */
  age?: string;
  /** Elapsed run time on a running card, mm:ss. */
  elapsed?: string;
  /** Sandbox the run is in, e.g. "sbx_8f2a41". */
  sandboxId?: string;
  /** CI check counts behind the review chips. */
  checks?: { passed: number; failed: number };
  /** What the reviewer is doing, e.g. "Rebase queued · 1st". */
  reviewState?: string;
  /** Two-line failure excerpt, rendered on anthracite. */
  logExcerpt?: [string, string];
  /** Diffstat footer on a review card, e.g. "+284 / −12 · 9 files". */
  diffstat?: string;
  /** Merge commit on a done ticket. */
  mergeCommit?: string;
}

export type ExtrasMap = Record<string, CardExtras | undefined>;

/** "claude-sonnet-4-5-20250929" reads as "SONNET 4 5" on a 9px badge. */
function modelTag(model: string | null): string | null {
  if (!model) return null;
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-/g, " ")
    .toUpperCase();
}

function Pips({ stage }: { stage: number }) {
  return (
    <span aria-hidden className="inline-flex items-center gap-1">
      {Array.from({ length: STAGE_COUNT }, (_, i) => (
        <span
          key={i}
          className={cn("oct size-3", i < stage ? "bg-anthracite" : "bg-line")}
        />
      ))}
    </span>
  );
}

function TerminalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="9"
        height="7"
        rx="1.5"
        stroke="var(--text-muted)"
        strokeWidth="1.2"
      />
      <path
        d="M3.5 5.5 5 6.75 3.5 8"
        stroke="var(--text-muted)"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The white card surface every column variant is built on. */
const SHELL = "bg-card border-line rounded-lg border";

/* -------------------------------------------------------------------------
 * Backlog
 * ---------------------------------------------------------------------- */

function BacklogEpic({ card, extras }: { card: BoardCard; extras: CardExtras }) {
  return (
    <div className={cn(SHELL, "flex flex-col gap-2 p-3")}>
      <div className="flex items-center gap-1.5">
        <CoinBadge tone="epic" className="tracking-[0.08em]">
          EPIC
        </CoinBadge>
        <span className="text-muted font-mono text-[10px]">{card.key}</span>
      </div>
      <h3 className="text-ink font-serif text-[16px] leading-dense font-semibold">
        {card.title}
      </h3>
      {extras.summary && (
        <p className="text-muted text-[11px] leading-[1.5]">{extras.summary}</p>
      )}
      <div className="flex items-center gap-1">
        <Pips stage={card.stage} />
        <span className="text-muted ml-1 font-mono text-[10px]">
          {card.stage}/{STAGE_COUNT}
          {extras.stageLabel ? ` · ${extras.stageLabel}` : ""}
        </span>
      </div>
    </div>
  );
}

function RawIdea({ card, extras }: { card: BoardCard; extras: CardExtras }) {
  return (
    <div className={cn(SHELL, "flex flex-col gap-1.5 p-3")}>
      <span className="text-muted font-mono text-[10px]">
        RAW{extras.age ? ` · ${extras.age}` : ""}
      </span>
      <h3 className="text-ink text-[13px] leading-card font-medium">
        {card.title}
      </h3>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * In Progress
 * ---------------------------------------------------------------------- */

function RunningCard({
  card,
  extras,
  agentLabel,
}: {
  card: BoardCard;
  extras: CardExtras;
  agentLabel: string | null;
}) {
  const model = modelTag(card.model);
  return (
    <div
      className={cn(
        "bg-card border-clay pulse-card flex flex-col gap-2.5 rounded-lg border p-3",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-muted font-mono text-[10px]">{card.key}</span>
        <div className="flex-grow" />
        {model && (
          <CoinBadge title="Model" className="tracking-[0.04em]">
            {model}
          </CoinBadge>
        )}
        {card.size && (
          <CoinBadge title="Ticket size" className="tracking-[0.04em]">
            {card.size}
          </CoinBadge>
        )}
        {card.storyPoints != null && (
          <CoinBadge title={`${card.storyPoints} story points`} className="tabular-nums">
            {card.storyPoints} pt
          </CoinBadge>
        )}
      </div>

      <h3 className="text-ink text-[13px] leading-card font-medium">
        {card.title}
      </h3>

      <div className="flex items-center gap-1.5">
        {agentLabel && (
          <StatusChip tone="clay" pulsing>
            {agentLabel}
          </StatusChip>
        )}
        {extras.elapsed && (
          <span className="text-muted font-mono text-[10px] tabular-nums">
            {extras.elapsed}
          </span>
        )}
      </div>

      {extras.progress && (
        <ProgressBar
          value={extras.progress.fraction}
          label={`${card.key} progress`}
          caption={extras.progress.label}
        />
      )}

      {extras.sandboxId && (
        <div className="border-hairline flex items-center gap-1.5 border-t pt-2">
          <TerminalIcon />
          <span className="text-muted font-mono text-[10px]">
            {extras.sandboxId}
          </span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * In Review
 * ---------------------------------------------------------------------- */

function ReviewCard({
  card,
  extras,
  agentLabel,
}: {
  card: BoardCard;
  extras: CardExtras;
  agentLabel: string | null;
}) {
  const failed = extras.checks?.failed ?? 0;
  const passed = extras.checks?.passed ?? 0;

  return (
    <div className={cn(SHELL, "flex flex-col gap-2.5 p-3")}>
      <div className="flex items-center gap-1.5">
        <span className="text-muted font-mono text-[10px]">{card.key}</span>
        <div className="flex-grow" />
        {card.prNumber && (
          <CoinBadge title="Pull request">PR #{card.prNumber}</CoinBadge>
        )}
      </div>

      <h3 className="text-ink text-[13px] leading-card font-medium">
        {card.title}
      </h3>

      <div className="flex flex-wrap gap-1.5">
        {failed > 0 ? (
          <StatusChip tone="crimson">
            {failed} check{failed === 1 ? "" : "s"} failed
          </StatusChip>
        ) : passed > 0 ? (
          <StatusChip tone="jade">
            {passed} check{passed === 1 ? "" : "s"} passed
          </StatusChip>
        ) : (
          <StatusChip tone="neutral">CI pending</StatusChip>
        )}
        {extras.reviewState && (
          <StatusChip tone="rust">{extras.reviewState}</StatusChip>
        )}
      </div>

      {/* A failure gets two lines of log on anthracite. Enough to recognise
          the error without opening the sandbox inspector. */}
      {extras.logExcerpt && (
        <div className="bg-anthracite rounded-md p-2">
          <span className="text-log-text block font-mono text-[9px] leading-[1.6]">
            {extras.logExcerpt[0]}
          </span>
          <span className="text-log-error block font-mono text-[9px] leading-[1.6]">
            {extras.logExcerpt[1]}
          </span>
        </div>
      )}

      {extras.diffstat && (
        <div className="border-hairline flex items-center gap-1.5 border-t pt-2 leading-[normal]">
          <span className="text-muted font-mono text-[10px]">
            {extras.diffstat}
          </span>
          <div className="flex-grow" />
          {agentLabel && (
            <span className="text-muted text-[10px] font-semibold">
              {agentLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Generic ticket, for a card that is none of the above (a blocked or failed
 * ticket sitting in Backlog, say).
 * ---------------------------------------------------------------------- */

function PlainTicket({
  card,
  extras,
  tone,
}: {
  card: BoardCard;
  extras: CardExtras;
  tone: "neutral" | "crimson" | "rust";
}) {
  const model = modelTag(card.model);
  return (
    <div className={cn(SHELL, "flex flex-col gap-2 p-3")}>
      <div className="flex items-center gap-1.5">
        <span className="text-muted font-mono text-[10px]">{card.key}</span>
        <div className="flex-grow" />
        {model && <CoinBadge title="Model">{model}</CoinBadge>}
        {card.size && <CoinBadge title="Ticket size">{card.size}</CoinBadge>}
        {card.storyPoints != null && (
          <CoinBadge title={`${card.storyPoints} story points`} className="tabular-nums">
            {card.storyPoints} pt
          </CoinBadge>
        )}
      </div>
      <h3 className="text-ink text-[13px] leading-card font-medium">
        {card.title}
      </h3>
      {card.blockedReason && (
        <StatusChip tone={tone}>{card.blockedReason}</StatusChip>
      )}
      {card.fileScope.length > 0 && (
        <span
          className="text-muted truncate font-mono text-[9px]"
          title={card.fileScope.join(", ")}
        >
          {card.fileScope.join(" · ")}
        </span>
      )}
      {extras.progress && (
        <ProgressBar
          value={extras.progress.fraction}
          label={`${card.key} progress`}
          caption={extras.progress.label}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The dispatcher
 * ---------------------------------------------------------------------- */

const AGENT_LABEL: Record<AgentRole, string> = {
  product: "Product Agent",
  architect: "Architect Agent",
  coder: "Coder Agent",
  reviewer: "Reviewer Agent",
  pm: "PM Agent",
};

export function CardBody({
  card,
  column,
  extras,
}: {
  card: BoardCard;
  column: ColumnId;
  extras: CardExtras;
}) {
  const agentLabel = card.agentRole ? AGENT_LABEL[card.agentRole] : null;

  if (card.kind === "epic") return <BacklogEpic card={card} extras={extras} />;

  if (column === "in_progress" && card.status === "running") {
    return <RunningCard card={card} extras={extras} agentLabel={agentLabel} />;
  }
  if (column === "in_review") {
    return <ReviewCard card={card} extras={extras} agentLabel={agentLabel} />;
  }
  if (column === "backlog" && !card.blockedReason) {
    return <RawIdea card={card} extras={extras} />;
  }

  return (
    <PlainTicket
      card={card}
      extras={extras}
      tone={card.status === "failed" ? "crimson" : "rust"}
    />
  );
}

/**
 * A top-level board card. Everything that is not an epic accordion — see
 * EpicGroup below — renders through here.
 */
export function KanbanCard({
  card,
  column,
  index,
  extras,
  onOpen,
}: {
  card: BoardCard;
  column: ColumnId;
  index: number;
  extras: ExtrasMap;
  onOpen: (card: BoardCard) => void;
}) {
  const draggable = isDraggable(card.status);

  return (
    <Draggable draggableId={card.id} index={index} isDragDisabled={!draggable}>
      {(provided, snapshot) => (
        <li
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={() => onOpen(card)}
          className={cn(
            "rounded-lg outline-none",
            draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default",
            snapshot.isDragging && "shadow-lift",
          )}
        >
          <CardBody card={card} column={column} extras={extras[card.id] ?? {}} />
        </li>
      )}
    </Draggable>
  );
}

/* -------------------------------------------------------------------------
 * Epic groups: the To Do DAG accordion and the Done merged group
 * ---------------------------------------------------------------------- */

/** A child row in a To Do accordion. Fixed 60px so the trail curves land. */
function ChildRow({ card }: { card: BoardCard }) {
  const blocked = card.status === "waiting" || card.status === "blocked";
  const failed = card.status === "failed";
  const caption = blocked
    ? card.blockedReason ?? `blocked by ${card.dependsOn.length} ticket(s)`
    : (card.fileScope[0] ?? "");

  return (
    <div
      className={cn(
        "border-line flex h-[60px] flex-col justify-center gap-1 rounded-md border px-2.5 py-2 leading-[normal]",
        blocked || failed ? "bg-nested-muted" : "bg-card",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "size-[5px] shrink-0 rounded-full",
            failed ? "bg-crimson" : blocked ? "bg-idle" : "bg-clay",
            card.status === "ready" && "pulse-dot",
          )}
        />
        <span className="text-muted font-mono text-[10px]">{card.key}</span>
        <h4
          className={cn(
            "truncate text-[12px] font-medium",
            blocked ? "text-muted" : "text-ink",
          )}
        >
          {card.title}
        </h4>
      </div>
      {caption && (
        <span className="text-muted truncate font-mono text-[9px]">{caption}</span>
      )}
    </div>
  );
}

/** A merged row in the Done group. */
function MergedRow({ card, extras }: { card: BoardCard; extras: CardExtras }) {
  const trail = [
    extras.mergeCommit ? `merged ${extras.mergeCommit}` : "merged",
    card.prNumber ? `PR #${card.prNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="bg-nested border-line flex flex-col gap-[5px] rounded-md border px-2.5 py-2 leading-[normal]">
      <div className="flex items-center gap-1.5">
        <span aria-hidden className="bg-jade size-[5px] shrink-0 rounded-full" />
        <span className="text-muted font-mono text-[10px]">{card.key}</span>
        <h4 className="text-ink truncate text-[12px] font-medium">
          {card.title}
        </h4>
      </div>
      <span className="text-muted font-mono text-[9px]">{trail}</span>
    </div>
  );
}

function ChevronUp({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={cn("transition-transform", collapsed && "rotate-180")}
    >
      <path
        d="M3 7.5 6 4.5 9 7.5"
        stroke="var(--text-muted)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * An epic and the tickets it owns in this column, rendered as one surface.
 *
 * In To Do that is the DAG: children sit on a tinted ground with the
 * pheromone trails drawn in the gutter beside them. In Done it is the merged
 * group, with the showcase call to action in its header.
 *
 * Each child stays its own Draggable — indices are allotted by the column so
 * they run contiguously through the group — so a ticket can still be pulled
 * out of its epic and dropped in the next column.
 */
export function EpicGroup({
  epic,
  tickets,
  column,
  index,
  extras,
  collapsed,
  onToggle,
  onOpen,
  onShowcase,
}: {
  epic: BoardCard;
  /** The epic's own tickets in this column, in render order. */
  tickets: BoardCard[];
  column: ColumnId;
  /** The epic's own index; children follow at index + 1, + 2, … */
  index: number;
  extras: ExtrasMap;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (card: BoardCard) => void;
  onShowcase?: (epic: BoardCard) => void;
}) {
  const own = extras[epic.id] ?? {};
  const done = column === "done";

  return (
    <li className={cn(SHELL, "flex flex-col overflow-hidden")}>
      <Draggable draggableId={epic.id} index={index} isDragDisabled={done}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            {...provided.dragHandleProps}
            className={cn(
              "border-hairline flex flex-col gap-2 border-b p-3",
              done ? "bg-jade-wash" : "bg-card",
              snapshot.isDragging && "shadow-lift",
            )}
          >
            <div className="flex items-center gap-1.5">
              <CoinBadge
                tone={done ? "merged" : "epic"}
                className="tracking-[0.08em]"
              >
                EPIC
              </CoinBadge>
              <span className="text-muted font-mono text-[10px]">
                {done
                  ? `${epic.key} · ${epic.doneCount}/${epic.childCount} merged`
                  : epic.key}
              </span>
              <div className="flex-grow" />
              {!done && (
                <button
                  type="button"
                  onClick={onToggle}
                  aria-expanded={!collapsed}
                  aria-label={
                    collapsed ? "Expand child tickets" : "Collapse child tickets"
                  }
                  className="inline-flex size-5 items-center justify-center"
                >
                  <ChevronUp collapsed={collapsed} />
                </button>
              )}
            </div>

            <h3 className="text-ink font-serif text-[16px] leading-dense font-semibold">
              <button
                type="button"
                onClick={() => onOpen(epic)}
                className="text-left"
              >
                {epic.title}
              </button>
            </h3>

            {!done && own.dagSummary && (
              <span className="text-muted font-mono text-[10px]">
                {own.dagSummary}
              </span>
            )}

            {done && onShowcase && (
              <button
                type="button"
                onClick={() => onShowcase(epic)}
                className="bg-terracotta-cta inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-[12px] font-semibold text-white transition-opacity hover:opacity-90"
              >
                View showcase
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M2.5 6h7M7 3.5 9.5 6 7 8.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        )}
      </Draggable>

      {!collapsed && tickets.length > 0 && (
        <div
          className={cn(
            "group relative",
            done ? "bg-card p-3" : "bg-nested py-3 pr-3 pl-[34px]",
          )}
        >
          {!done && (
            <ColumnTrail
              unlocked={tickets.map(
                (c) => c.status !== "waiting" && c.status !== "blocked",
              )}
            />
          )}
          <div className="flex flex-col [&>div:not(:last-child)]:mb-2">
            {tickets.map((child, i) => (
              <Draggable
                key={child.id}
                draggableId={child.id}
                index={index + 1 + i}
                isDragDisabled={!isDraggable(child.status)}
              >
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.draggableProps}
                    {...provided.dragHandleProps}
                    onClick={() => onOpen(child)}
                    className={cn(
                      "rounded-md outline-none",
                      isDraggable(child.status)
                        ? "cursor-grab active:cursor-grabbing"
                        : "cursor-default",
                      snapshot.isDragging && "shadow-lift",
                    )}
                  >
                    {done ? (
                      <MergedRow card={child} extras={extras[child.id] ?? {}} />
                    ) : (
                      <ChildRow card={child} />
                    )}
                  </div>
                )}
              </Draggable>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}
