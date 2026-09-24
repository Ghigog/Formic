"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { CoinBadge } from "@/components/ui/coin-badge";
import { MarkdownLite } from "@/components/ui/markdown-lite";
import { PlanSteps } from "@/components/ui/plan-steps";
import { SideBySide, WithChat } from "@/components/ui/split";
import { StatusPill } from "@/components/ui/status-pill";
import { StepIndicator } from "@/components/ui/step-indicator";
import type { FormicEvent } from "@/lib/domain/events";
import { AGENT_ROLE_LABELS, COLUMN_AGENT_ROLE } from "@/lib/domain/entities";
import { TICKET_STAGES, ticketProgress } from "@/lib/domain/stages";
import { columnFor, isStalled } from "@/lib/domain/status";
import { CardChat } from "./card-chat";
import { ProblemNotice, WorkTimer } from "./card";
import {
  activityOf,
  appendActivity,
  type TicketActivity,
  type TicketView,
} from "@/lib/domain/ticket-view";

/** Hands the drawer the board's live events; returns how to stop. */
export type SubscribeToEvents = (
  listener: (event: FormicEvent, seq: number) => void,
) => () => void;

/**
 * A ticket's own view. On the left, the ticket as it was written: the user
 * story, why, what, how and its acceptance criteria. On the right, the
 * agent working it: its plan, stepped through like the Epic's lifecycle,
 * and what it thought and did, live while it works.
 *
 * Full-screen bottom sheet on mobile, like the Epic drawer.
 */
export function TicketDrawer({
  ticketId,
  onClose,
  onOpenEpic,
  subscribe,
}: {
  ticketId: string | null;
  onClose: () => void;
  onOpenEpic: (epicId: string) => void;
  subscribe: SubscribeToEvents;
}) {
  const [view, setView] = useState<TicketView | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<"ticket" | "agent">("ticket");

  // Another ticket: nothing of the last one's stays on screen.
  const [shownFor, setShownFor] = useState(ticketId);
  if (ticketId !== shownFor) {
    setShownFor(ticketId);
    setView(null);
    setFailed(false);
  }

  const load = useCallback(async () => {
    if (!ticketId) return;
    return fetch(`/api/tickets/${ticketId}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<TicketView>) : null))
      .then(
        (found) => (found ? setView(found) : setFailed(true)),
        () => setFailed(true),
      );
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live: thoughts and actions append, a new plan replaces the old, and a
  // change of status reloads the ticket itself.
  useEffect(() => {
    if (!ticketId) return;
    return subscribe((event, seq) => {
      if (event.type === "ticket.plan" && event.ticketId === ticketId) {
        setView((v) => (v ? { ...v, plan: event.steps } : v));
        return;
      }
      if (
        ((event.type === "card.status" || event.type === "card.created") && event.cardId === ticketId) ||
        (event.type === "ci.status" && event.ticketId === ticketId)
      ) {
        void load();
        return;
      }
      const item = activityOf(event, ticketId, seq, new Date().toISOString());
      if (item) setView((v) => (v ? { ...v, activity: appendActivity(v.activity, item) } : v));
    });
  }, [ticketId, subscribe, load]);

  useEffect(() => {
    if (!ticketId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ticketId, onClose]);

  if (!ticketId) return null;

  const card = view?.card;
  const progress = card ? ticketProgress(card) : { current: 3, working: false, failedAt: null };

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Ticket detail"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg border-line flex h-[92dvh] w-full max-w-5xl flex-col rounded-t-lg border sm:h-[85dvh] sm:rounded-lg"
      >
        <header className="border-line shrink-0 border-b p-4">
          {card && <ProblemNotice card={card} className="mb-3" />}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-fg-subtle font-mono text-[10px]">{card?.key ?? "TICKET"}</span>
                {view?.epic && (
                  <button
                    type="button"
                    onClick={() => onOpenEpic(view.epic!.id)}
                    className="text-fg-subtle hover:text-terracotta truncate text-[11px] underline-offset-2 hover:underline"
                  >
                    in {view.epic.key}: {view.epic.title}
                  </button>
                )}
              </div>
              <h2 className="mt-0.5 font-serif text-[18px] leading-tight font-semibold">
                {card?.title ?? (failed ? "Ticket" : "Loading…")}
              </h2>
              {card && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <StatusPill status={card.status} />
                  {card.workingSince && (
                    <span className="text-ochre-text inline-flex items-center gap-1 text-[11px]">
                      Working for <WorkTimer since={card.workingSince} className="text-ochre-text" />
                    </span>
                  )}
                  {card.storyPoints != null && (
                    <CoinBadge title={`${card.storyPoints} story points`} className="tabular-nums">
                      {card.storyPoints} pt
                    </CoinBadge>
                  )}
                  {card.size && <CoinBadge title="Ticket size">{card.size}</CoinBadge>}
                  {card.prUrl && (
                    <a
                      href={card.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-terracotta text-[11px] font-medium underline-offset-2 hover:underline"
                    >
                      PR #{card.prNumber}
                    </a>
                  )}
                </div>
              )}
            </div>
            {view?.canStop && <StopButton ticketId={ticketId} onStopped={load} />}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-fg-muted hover:text-fg border-line rounded border px-1.5 py-0.5 text-[12px]"
            >
              Close
            </button>
          </div>

          <StepIndicator
            className="mt-3"
            stages={TICKET_STAGES}
            label="Ticket progress"
            current={progress.current}
            failedAt={progress.failedAt}
            working={progress.working}
          />

          {/* A reason it waits that is not a problem, such as a dependency. */}
          {card?.blockedReason && !card.misplacedReason && !isStalled(card.status) && (
            <p className="bg-sunken text-fg-muted mt-3 rounded-md px-2 py-1.5 text-[12px] leading-5">
              {card.blockedReason}
            </p>
          )}
        </header>

        {/* Tabs below the dual-pane breakpoint, where two columns do not fit. */}
        <div className="border-line flex shrink-0 gap-0.5 border-b px-2 py-1 lg:hidden">
          {(["ticket", "agent"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-2 py-1 text-[12px] font-medium",
                tab === t ? "bg-amber text-on-amber" : "text-fg-muted",
              )}
            >
              {t === "ticket" ? "Ticket" : "Agent"}
            </button>
          ))}
        </div>

        <SideBySide
          storageKey="ticket"
          first={
            <section
              aria-label="Ticket"
              className={cn("min-h-0 overflow-y-auto p-4", tab === "ticket" ? "block" : "hidden lg:block")}
            >
              {view && <TicketBody view={view} />}
            </section>
          }
          second={
            <section
              aria-label="Agent"
              className={cn("bg-sunken min-h-0 flex-col", tab === "agent" ? "flex" : "hidden lg:flex")}
            >
              <WithChat
                storageKey="ticket"
                fixed
                chat={
                  view && (
                    <CardChat
                      kind="ticket"
                      inputOnly
                      cardId={ticketId}
                      agentLabel={AGENT_ROLE_LABELS[COLUMN_AGENT_ROLE[columnFor(view.card.status, view.card.stalledIn)]]}
                    />
                  )
                }
              >
                <div className="p-4">{view && <AgentBody view={view} working={progress.working} />}</div>
              </WithChat>
            </section>
          }
        />
      </div>
    </div>
  );
}

/** The ticket as it was written. */
function TicketBody({ view }: { view: TicketView }) {
  return (
    <div className="text-fg space-y-4 text-[13px] leading-6">
      <MarkdownLite text={view.description} />

      {view.acceptanceCriteria.length > 0 && (
        <div>
          <Heading>Acceptance criteria</Heading>
          <ul className="mt-1 space-y-1.5">
            {view.acceptanceCriteria.map((c, i) => (
              <li key={i} className="border-line bg-surface rounded-md border px-2 py-1.5">
                <Gherkin text={c} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.handoff.length > 0 && (
        <div>
          <Heading>For you</Heading>
          <p className="text-fg-muted mt-1 text-[12px]">
            Steps outside the repository no agent can take. The Epic&apos;s showcase lists them again once
            everything has merged.
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {view.handoff.map((s, i) => (
              <li key={i}>
                <MarkdownLite text={s} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <Heading>File scope</Heading>
        <p className="text-fg-muted mt-1 font-mono text-[11px]">
          {view.card.fileScope.join(" · ") || "(no scope)"}
        </p>
      </div>

      {view.dependsOn.length > 0 && (
        <div>
          <Heading>Waits on</Heading>
          <ul className="mt-1 space-y-1">
            {view.dependsOn.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-[12px]">
                <span className="text-fg-subtle font-mono text-[10px]">{d.key}</span>
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                <StatusPill status={d.status as TicketView["card"]["status"]} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {view.summary && (
        <div>
          <Heading>What the agent changed</Heading>
          <p className="mt-1">{view.summary}</p>
        </div>
      )}
    </div>
  );
}

/** "Given …, when …, then …" with its keywords picked out. */
function Gherkin({ text }: { text: string }) {
  const parts = text.split(/\b(Given|given|When|when|Then|then)\b/);
  return (
    <span>
      {parts.map((p, i) =>
        /^(given|when|then)$/i.test(p) ? (
          <strong key={i} className="text-ochre-text font-semibold">
            {p}
          </strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

/** The agent: its plan, then what it thought and did, newest at the bottom. */
function AgentBody({ view, working }: { view: TicketView; working: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const count = view.activity.length;
  // Follow the feed as it grows, the way a terminal does.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [count]);

  return (
    <div className="space-y-5">
      <div>
        <Heading>Plan</Heading>
        {view.plan.length > 0 ? (
          <PlanSteps className="mt-2" steps={view.plan} working={working} />
        ) : (
          <p className="text-fg-subtle mt-1 text-[12px]">
            {working
              ? "The agent has not shared a plan yet."
              : "No plan yet. The agent shares one when it starts on this ticket."}
          </p>
        )}
      </div>

      <div>
        <Heading>Thought process</Heading>
        {view.activity.length === 0 ? (
          <p className="text-fg-subtle mt-1 text-[12px]">
            Nothing yet. What the agent thinks and does shows here as it works.
          </p>
        ) : (
          <ol className="mt-2 space-y-2">
            {view.activity.map((a) => (
              <ActivityLine key={a.seq} item={a} />
            ))}
          </ol>
        )}
        <div ref={end} />
      </div>
    </div>
  );
}

/** Stops the agent working the ticket, wherever it runs. */
function StopButton({ ticketId, onStopped }: { ticketId: string; onStopped: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/tickets/${ticketId}/stop`, { method: "POST" }).catch(() => undefined);
        setBusy(false);
        onStopped();
      }}
      className="text-log-error border-log-error/40 hover:bg-log-error/10 rounded border px-1.5 py-0.5 text-[12px] font-medium disabled:opacity-60"
    >
      {busy ? "Stopping…" : "Stop agent"}
    </button>
  );
}

function ActivityLine({ item }: { item: TicketActivity }) {
  if (item.kind === "note") {
    return (
      <li className="border-amber/50 bg-surface ml-6 rounded-md border px-2 py-1.5 text-[12px] leading-5 whitespace-pre-wrap">
        <span className="text-ochre-text mr-1 font-semibold">You:</span>
        {item.text}
      </li>
    );
  }
  if (item.kind === "reply" && !item.agent) {
    return <li className="text-fg-muted px-2 text-[11px] leading-5 italic">{item.text}</li>;
  }
  if (item.kind === "reply") {
    return (
      <li className="bg-surface text-fg mr-6 rounded-md px-2 py-1.5 text-[12px] leading-5 whitespace-pre-wrap">
        <span className="text-fg-muted mr-1 font-semibold">{item.agent}:</span>
        {item.text}
      </li>
    );
  }
  if (item.kind === "action") {
    return (
      <li className="text-fg-muted flex items-center gap-1.5 font-mono text-[11px]">
        <span aria-hidden className="bg-clay size-1.5 shrink-0 rounded-full" />
        {item.text}
      </li>
    );
  }
  return (
    <li
      className={cn(
        "rounded-md px-2 py-1.5 text-[12px] leading-5 whitespace-pre-wrap",
        item.kind === "thinking" ? "text-fg-muted border-line border italic" : "bg-surface text-fg",
      )}
    >
      {item.kind === "thinking" && <span className="sr-only">Thinking: </span>}
      {item.text}
    </li>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-fg-subtle font-mono text-[10px] tracking-wide uppercase">{children}</h3>
  );
}
