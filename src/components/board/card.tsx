"use client";

import { createContext, useContext, useRef } from "react";
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
import { COLUMN_LABELS, cardProblem, type ColumnId } from "@/lib/domain/status";
import { isBug, isSquashed } from "@/lib/colony/game";
import { spRadius, spVerts } from "@/components/colony/fx";
import { useColony } from "@/components/colony/colony";
import { formatCountdown, useElapsed } from "@/lib/hooks/use-countdown";

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


/** "claude-sonnet-4-5-20250929" reads as "sonnet 4 5". */
function modelTag(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-/g, " ");
}

/** The white card surface the epic groups are built on. */
const SHELL = "bg-card border-line rounded-lg border";

/** What a card needs from the board around it. */
export interface CardEnv {
  epics: ReadonlyMap<string, BoardCard>;
  /** Where a card's arrow sends it, or null when it has no arrow. */
  nextFor: (card: BoardCard, column: ColumnId) => ColumnId | null;
  onAdvance: (card: BoardCard, to: ColumnId) => void;
  /** The running ticket a queued one is waiting on, or null when none is. */
  queuedBehind?: (card: BoardCard) => BoardCard | null;
}

export const CardEnvContext = createContext<CardEnv | null>(null);

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

/**
 * The story-point coin: a polygon with more sides the bigger the ticket.
 * Its ant crew picks the polygon up while an agent works the ticket.
 */
export function SpBadge({ points, done = false }: { points: number | null | undefined; done?: boolean }) {
  const has = points != null;
  const verts = has
    ? spVerts(points, 6, 6, Math.min(5.6, spRadius(points) * 1.15))
        .map((p) => p.map((v) => v.toFixed(2)).join(","))
        .join(" ")
    : "";
  return (
    <span data-sp className="inline-flex shrink-0">
    <CoinBadge
      title={has ? `${points} story points` : "Not estimated yet"}
      className="gap-1 pl-1.5 tracking-[0.04em] tabular-nums"
    >
      {has && (
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
          <polygon
            points={verts}
            fill={done ? "none" : "var(--clay)"}
            stroke="var(--terracotta-deep)"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {has ? `${points} SP` : "? SP"}
    </CoinBadge>
    </span>
  );
}

function BugBadge({ squashed }: { squashed: boolean }) {
  return squashed ? (
    <span className="oct inline-flex shrink-0 bg-idle p-px">
      <span className="oct text-muted inline-flex items-center gap-1 bg-hairline py-0.5 pr-[7px] pl-1.5 font-mono text-[9px] tracking-[0.08em] whitespace-nowrap">
        <svg width="11" height="9" viewBox="0 0 12 10" fill="none" aria-hidden="true">
          <ellipse cx="6" cy="6.5" rx="5" ry="1.6" fill="var(--text-muted)" />
          <circle cx="1.5" cy="4.5" r="0.8" fill="var(--text-muted)" />
          <circle cx="10.2" cy="4" r="0.6" fill="var(--text-muted)" />
        </svg>
        SQUASHED
      </span>
    </span>
  ) : (
    <span data-bugicon className="oct bg-crimson inline-flex shrink-0 p-px">
      <span className="oct inline-flex items-center gap-1 bg-crimson-chip py-0.5 pr-[7px] pl-1.5 font-mono text-[9px] tracking-[0.08em] whitespace-nowrap text-crimson-chip-text">
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <ellipse cx="5" cy="6" rx="2.4" ry="3" fill="var(--crimson-chip-text)" />
          <circle cx="5" cy="2.2" r="1.3" fill="var(--crimson-chip-text)" />
          <path
            d="M2.6 4.5 1 3.6M2.6 6.2H.8M2.6 7.9 1 8.8M7.4 4.5 9 3.6M7.4 6.2h1.8M7.4 7.9 9 8.8"
            stroke="var(--crimson-chip-text)"
            strokeWidth="0.8"
            strokeLinecap="round"
          />
        </svg>
        BUG
      </span>
    </span>
  );
}

/** The arrow that sends a card on to the next column, where it may go. */
function AdvanceButton({ card, column }: { card: BoardCard; column: ColumnId }) {
  const env = useContext(CardEnvContext);
  const to = env?.nextFor(card, column) ?? null;
  if (!env || !to) return null;
  return (
    <button
      type="button"
      aria-label={`Move ${card.key} to ${COLUMN_LABELS[to]}`}
      onClick={(e) => {
        e.stopPropagation();
        env.onAdvance(card, to);
      }}
      className="hover:bg-column -my-0.5 -mr-1 inline-flex size-[22px] shrink-0 items-center justify-center rounded-md"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path
          d="M2.5 6h7M7 3.5 9.5 6 7 8.5"
          stroke="var(--text-muted)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** What each planning agent is doing to an Epic, for its card and drawer. */
export const EPIC_WORK: Partial<Record<AgentRole, string>> = {
  product: "Product Agent is writing the PRD…",
  architect: "Architect Agent is breaking it into tickets…",
  pm: "PM Agent is writing the showcase…",
};

/**
 * How long the agent on a card has been at it, ticking. Shown only while one
 * is working, so a card sitting idle does not look busy.
 */
export function WorkTimer({ since, className }: { since?: string | null; className?: string }) {
  const ms = useElapsed(since);
  if (ms === null) return null;
  return (
    <span
      title="Time the agent has been working on this"
      className={cn("text-muted font-mono text-[10px] tabular-nums", className)}
    >
      {formatCountdown(ms)}
    </span>
  );
}

/** A live line on an Epic while one of its planning agents works. */
function EpicWorking({ card }: { card: BoardCard }) {
  const label = card.agentRole ? EPIC_WORK[card.agentRole] : undefined;
  if (!label) return null;
  return (
    <span className="text-ochre-text flex items-center gap-1.5 text-[11px]">
      <span aria-hidden className="bg-ochre pulse-dot size-[5px] shrink-0 rounded-full" />
      {label}
      <WorkTimer since={card.workingSince} className="ml-auto" />
    </span>
  );
}

/**
 * A red "!" on a card that needs a person: it was put somewhere it cannot
 * work, or its agent stopped. Opening the card says what and how to fix it.
 */
export function ProblemBadge({ card }: { card: BoardCard }) {
  const problem = cardProblem(card);
  if (!problem) return null;
  return (
    <span
      role="img"
      aria-label={`Needs you: ${problem}`}
      title={problem}
      className="bg-crimson text-on-crimson inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] leading-none font-bold"
    >
      !
    </span>
  );
}

/**
 * The same problem, spelled out at the top of an opened card: what is wrong
 * and what to do about it.
 */
export function ProblemNotice({ card, className }: { card: BoardCard; className?: string }) {
  const problem = cardProblem(card);
  if (!problem) return null;
  return (
    <div
      role="alert"
      className={cn("bg-crimson/10 text-ink flex items-start gap-2 rounded-md px-2.5 py-2 text-[12px] leading-5", className)}
    >
      <span
        aria-hidden
        className="bg-crimson text-on-crimson mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] leading-none font-bold"
      >
        !
      </span>
      <p className="min-w-0">
        <span className="font-semibold">
          {card.misplacedReason ? "It can't work here. " : "This needs you. "}
        </span>
        {problem}
      </p>
    </div>
  );
}

/** Which epic a ticket belongs to, or what an orphan is. */
function EpicLine({ card }: { card: BoardCard }) {
  const env = useContext(CardEnvContext);
  const epic = card.epicId ? env?.epics.get(card.epicId) : undefined;
  const text = epic ? `${epic.key} · ${epic.title}` : isBug(card) ? "Triage" : card.epicId ? null : "Raw idea";
  if (!text) return null;
  return <span className="text-muted truncate font-mono text-[9px]">{text}</span>;
}

/**
 * The surface every card is drawn on. It carries the card's id for the
 * colony's effects, a canvas for the trails its ants dig, and a slight tilt
 * toward the pointer.
 */
function CardShell({
  card,
  className,
  children,
}: {
  card: BoardCard;
  className?: string;
  children: React.ReactNode;
}) {
  const colony = useColony();
  const lastHover = useRef(0);
  return (
    <div
      data-tid={card.id}
      onPointerEnter={() => {
        if (!colony) return;
        const now = performance.now();
        if (now - lastHover.current > 70) {
          lastHover.current = now;
          colony.sfx("hover");
        }
      }}
      onPointerMove={(e) => {
        if (!colony || colony.fx.reducedMotion || e.pointerType === "touch" || e.buttons) return;
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(700px) rotateX(${(-py * 5).toFixed(2)}deg) rotateY(${(px * 7).toFixed(2)}deg) translateY(-2px)`;
      }}
      onPointerLeave={(e) => {
        e.currentTarget.style.transform = "";
      }}
      className={cn(
        "relative isolate rounded-lg border transition-[transform,box-shadow,background-color,border-color] duration-150 ease-[cubic-bezier(.2,.8,.2,1)] hover:shadow-[0_12px_24px_-14px_color-mix(in_srgb,var(--anthracite)_35%,transparent)]",
        className,
      )}
    >
      <canvas
        data-trail
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 size-full rounded-[7px]"
      />
      {children}
    </div>
  );
}

/**
 * The timer on a queued ticket, top left. Hovered, it names the ticket it is
 * waiting on; its ant crew gathers around it until that one is done.
 */
function QueueTimer({ card }: { card: BoardCard }) {
  const env = useContext(CardEnvContext);
  const blocker = env?.queuedBehind?.(card) ?? null;
  const label = blocker
    ? `Waiting for ${blocker.key} to finish. It starts on its own then.`
    : "Up next. Starting now.";
  return (
    <span
      data-queue
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <circle cx="7" cy="8" r="5" stroke="var(--clay)" strokeWidth="1.3" />
        <path d="M5.5 1.5h3M7 1.5v1.5" stroke="var(--clay)" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M7 8V5.5M7 8l1.8 1.2" stroke="var(--terracotta-deep)" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function TicketHead({
  card,
  column,
  pr = false,
}: {
  card: BoardCard;
  column: ColumnId;
  pr?: boolean;
}) {
  return (
    <div className="flex min-h-[18px] items-center gap-1.5">
      {card.status === "queued" && <QueueTimer card={card} />}
      {isBug(card) && <BugBadge squashed={isSquashed(card)} />}
      <span className="text-muted shrink-0 font-mono text-[10px] whitespace-nowrap">{card.key}</span>
      <div className="flex-grow" />
      <ProblemBadge card={card} />
      {pr && card.prNumber && (
        <CoinBadge title="Pull request" className="shrink-0 whitespace-nowrap">
          PR #{card.prNumber}
        </CoinBadge>
      )}
      <SpBadge points={card.storyPoints} done={card.status === "merged"} />
      <AdvanceButton card={card} column={column} />
    </div>
  );
}

function Title({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <h3 className={cn("text-[13px] leading-card font-medium text-pretty", muted ? "text-muted" : "text-ink")}>
      {children}
    </h3>
  );
}

/* -------------------------------------------------------------------------
 * Backlog
 * ---------------------------------------------------------------------- */

function BacklogEpic({
  card,
  column,
  extras,
}: {
  card: BoardCard;
  column: ColumnId;
  extras: CardExtras;
}) {
  return (
    <CardShell card={card} className="bg-card border-line flex flex-col gap-2 p-3">
      <div className="flex min-h-[18px] items-center gap-1.5">
        <CoinBadge tone="epic" className="tracking-[0.08em]">
          EPIC
        </CoinBadge>
        {isBug(card) && <BugBadge squashed={isSquashed(card)} />}
        <span className="text-muted font-mono text-[10px]">{card.key}</span>
        <div className="flex-grow" />
        <ProblemBadge card={card} />
        <AdvanceButton card={card} column={column} />
      </div>
      <h3 className="text-ink font-serif text-[16px] leading-dense font-semibold">
        {card.title}
      </h3>
      {extras.summary && (
        <p className="text-muted text-[11px] leading-[1.5]">{extras.summary}</p>
      )}
      <EpicWorking card={card} />
      <div className="flex items-center gap-1">
        <Pips stage={card.stage} />
        <span className="text-muted ml-1 font-mono text-[10px]">
          {card.stage}/{STAGE_COUNT}
          {extras.stageLabel ? ` · ${extras.stageLabel}` : ""}
        </span>
      </div>
    </CardShell>
  );
}

function RawIdea({
  card,
  column,
  extras,
}: {
  card: BoardCard;
  column: ColumnId;
  extras: CardExtras;
}) {
  return (
    <CardShell card={card} className="bg-card border-line flex flex-col gap-2 p-3">
      <TicketHead card={card} column={column} />
      <Title>{card.title}</Title>
      <span className="text-muted truncate font-mono text-[9px]">
        {isBug(card) ? "Triage" : "Raw idea"}
        {extras.age ? ` · ${extras.age}` : ""}
      </span>
    </CardShell>
  );
}

/* -------------------------------------------------------------------------
 * In Progress
 * ---------------------------------------------------------------------- */

function RunningCard({
  card,
  column,
  extras,
  agentLabel,
}: {
  card: BoardCard;
  column: ColumnId;
  extras: CardExtras;
  agentLabel: string | null;
}) {
  const model = modelTag(card.model);
  return (
    <CardShell card={card} className="bg-card border-clay pulse-card flex flex-col gap-2 p-3">
      <TicketHead card={card} column={column} />
      <Title>{card.title}</Title>
      <EpicLine card={card} />

      <div className="flex items-center gap-1.5">
        {agentLabel && (
          <span title={model ?? undefined}>
            <StatusChip tone="clay" pulsing>
              {agentLabel}
            </StatusChip>
          </span>
        )}
        {extras.elapsed ? (
          <span className="text-muted font-mono text-[10px] tabular-nums">
            {extras.elapsed}
          </span>
        ) : (
          <WorkTimer since={card.workingSince} />
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
    </CardShell>
  );
}

/** In Progress, waiting its turn behind a ticket writing the same files. */
function QueuedCard({ card, column }: { card: BoardCard; column: ColumnId }) {
  return (
    <CardShell card={card} className="bg-nested-muted border-line flex flex-col gap-2 p-3">
      <TicketHead card={card} column={column} />
      <Title muted>{card.title}</Title>
      <EpicLine card={card} />
    </CardShell>
  );
}

/* -------------------------------------------------------------------------
 * In Review
 * ---------------------------------------------------------------------- */

function ReviewCard({
  card,
  column,
  extras,
  agentLabel,
}: {
  card: BoardCard;
  column: ColumnId;
  extras: CardExtras;
  agentLabel: string | null;
}) {
  const failed = extras.checks?.failed ?? 0;
  const passed = extras.checks?.passed ?? 0;
  const green = extras.ci === "passing" || (failed === 0 && passed > 0);

  return (
    <CardShell
      card={card}
      className={cn("bg-card flex flex-col gap-2 p-3", green ? "border-jade-line" : "border-line")}
    >
      <TicketHead card={card} column={column} pr />
      <Title>{card.title}</Title>
      <EpicLine card={card} />

      <div className="flex flex-wrap gap-1.5">
        {failed > 0 || extras.ci === "failing" ? (
          <StatusChip tone="crimson">
            {failed > 0 ? `${failed} check${failed === 1 ? "" : "s"} failed` : "Checks failed"}
          </StatusChip>
        ) : green ? (
          <StatusChip tone="jade">
            {passed > 0 ? `${passed} check${passed === 1 ? "" : "s"} passed` : "Checks passed"}
          </StatusChip>
        ) : (
          <StatusChip tone="clay" pulsing>
            CI running
          </StatusChip>
        )}
        {extras.reviewState && (
          <StatusChip tone="rust">{extras.reviewState}</StatusChip>
        )}
        {card.workingSince && agentLabel && (
          <span className="inline-flex items-center gap-1.5">
            <StatusChip tone="clay" pulsing>
              {agentLabel}
            </StatusChip>
            <WorkTimer since={card.workingSince} />
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
    </CardShell>
  );
}

/* -------------------------------------------------------------------------
 * Done, on its own: a merged ticket with no epic group to sit in.
 * ---------------------------------------------------------------------- */

function DoneCard({ card, column, extras }: { card: BoardCard; column: ColumnId; extras: CardExtras }) {
  const trail = [
    extras.mergeCommit ? `merged ${extras.mergeCommit}` : "merged",
    card.prNumber ? `PR #${card.prNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <CardShell card={card} className="flex flex-col gap-2 border-done-card-line bg-done-card p-3">
      <TicketHead card={card} column={column} pr />
      <Title>{card.title}</Title>
      <EpicLine card={card} />
      <span className="text-muted inline-flex items-center gap-1.5 font-mono text-[9px]">
        <span aria-hidden className="bg-jade size-[5px] rounded-full" />
        {trail}
      </span>
    </CardShell>
  );
}

/* -------------------------------------------------------------------------
 * Generic ticket, for a card that is none of the above (a blocked or failed
 * ticket sitting in Backlog, say).
 * ---------------------------------------------------------------------- */

function PlainTicket({
  card,
  column,
  extras,
}: {
  card: BoardCard;
  column: ColumnId;
  extras: CardExtras;
}) {
  const failed = card.status === "failed";
  const held = card.status === "waiting" || card.status === "blocked";
  return (
    <CardShell
      card={card}
      className={cn("border-line flex flex-col gap-2 p-3", held ? "bg-nested-muted" : "bg-card")}
    >
      <TicketHead card={card} column={column} />
      <Title muted={held}>{card.title}</Title>
      <EpicLine card={card} />
      {card.blockedReason &&
        (failed ? (
          // Failure reasons can be raw CLI output; keep them to one line so
          // they never push the card wider than its column.
          <StatusChip tone="crimson" className="max-w-full self-start">
            <span className="truncate" title={card.blockedReason}>
              {card.blockedReason}
            </span>
          </StatusChip>
        ) : (
          <span className="text-muted inline-flex min-w-0 items-center gap-1.5 font-mono text-[9px]">
            <span aria-hidden className="bg-idle size-[5px] shrink-0 rounded-full" />
            <span className="truncate" title={card.blockedReason}>
              {card.blockedReason}
            </span>
          </span>
        ))}
      {extras.progress && (
        <ProgressBar
          value={extras.progress.fraction}
          label={`${card.key} progress`}
          caption={extras.progress.label}
        />
      )}
    </CardShell>
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

  if (card.kind === "epic") return <BacklogEpic card={card} column={column} extras={extras} />;
  // Somewhere it cannot work: none of that column's anatomy applies to it.
  if (card.misplacedIn) return <PlainTicket card={card} column={column} extras={extras} />;

  if (column === "in_progress" && card.status === "running") {
    return <RunningCard card={card} column={column} extras={extras} agentLabel={agentLabel} />;
  }
  if (column === "in_progress" && card.status === "queued") {
    return <QueuedCard card={card} column={column} />;
  }
  if (column === "in_review") {
    return <ReviewCard card={card} column={column} extras={extras} agentLabel={agentLabel} />;
  }
  if (column === "done" && card.status === "merged") {
    return <DoneCard card={card} column={column} extras={extras} />;
  }
  if (column === "backlog" && !card.blockedReason) {
    return <RawIdea card={card} column={column} extras={extras} />;
  }

  return <PlainTicket card={card} column={column} extras={extras} />;
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
  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <li
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={() => onOpen(card)}
          className="cursor-grab rounded-lg outline-none active:cursor-grabbing"
        >
          {/* Picked up, the card leans into the drag. */}
          <div
            className={cn(
              "rounded-lg transition-transform duration-150",
              snapshot.isDragging &&
                "scale-[1.04] rotate-[-2deg] shadow-[0_28px_48px_-18px_color-mix(in_srgb,var(--anthracite)_45%,transparent),0_2px_6px_color-mix(in_srgb,var(--anthracite)_8%,transparent)]",
            )}
          >
            <CardBody card={card} column={column} extras={extras[card.id] ?? {}} />
          </div>
        </li>
      )}
    </Draggable>
  );
}

/* -------------------------------------------------------------------------
 * Epic groups: the To Do DAG accordion and the Done merged group
 * ---------------------------------------------------------------------- */

/** A child row in a To Do accordion. Fixed 60px so the trail curves land. */
function ChildRow({ card, column }: { card: BoardCard; column: ColumnId }) {
  const blocked = card.status === "waiting" || card.status === "blocked";
  const failed = card.status === "failed";
  const caption = blocked
    ? card.blockedReason ?? `blocked by ${card.dependsOn.length} ticket(s)`
    : (card.fileScope[0] ?? "");

  return (
    <div
      data-tid={card.id}
      className={cn(
        "border-line relative isolate flex h-[60px] flex-col justify-center gap-1 rounded-md border px-2.5 py-2 leading-[normal]",
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
        <ProblemBadge card={card} />
        <h4
          className={cn(
            "min-w-0 flex-1 truncate text-[12px] font-medium",
            blocked ? "text-muted" : "text-ink",
          )}
        >
          {card.title}
        </h4>
        {card.storyPoints != null && (
          <span className="text-muted shrink-0 font-mono text-[9px]">{card.storyPoints} SP</span>
        )}
        <AdvanceButton card={card} column={column} />
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
    <div
      data-tid={card.id}
      className="bg-nested border-line flex flex-col gap-[5px] rounded-md border px-2.5 py-2 leading-[normal]"
    >
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
  const colony = useColony();

  return (
    // Never shrunk to fit: a full column scrolls instead. Without this an
    // overflowing column squeezed each group down to its border.
    <li className={cn(SHELL, "flex shrink-0 flex-col overflow-hidden")}>
      <Draggable draggableId={epic.id} index={index}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            {...provided.dragHandleProps}
            data-tid={epic.id}
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
              <ProblemBadge card={epic} />
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

            {!done && <EpicWorking card={epic} />}

            {!done && own.dagSummary && (
              <span className="text-muted font-mono text-[10px]">
                {own.dagSummary}
              </span>
            )}

            {done && onShowcase && (
              <button
                type="button"
                onPointerEnter={() => colony?.sfx("hover")}
                onClick={() => {
                  colony?.sfx("click");
                  onShowcase(epic);
                }}
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
            // A long list scrolls inside the group, so one big Epic does not
            // push everything else in the column out of reach.
            "group scroll-area relative max-h-[min(420px,55dvh)]",
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
              >
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.draggableProps}
                    {...provided.dragHandleProps}
                    onClick={() => onOpen(child)}
                    className={cn(
                      "cursor-grab rounded-md outline-none active:cursor-grabbing",
                      snapshot.isDragging && "shadow-lift",
                    )}
                  >
                    {done ? (
                      <MergedRow card={child} extras={extras[child.id] ?? {}} />
                    ) : (
                      <ChildRow card={child} column={column} />
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
