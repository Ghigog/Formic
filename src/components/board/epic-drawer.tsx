"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { StepIndicator } from "@/components/ui/step-indicator";
import { StatusPill } from "@/components/ui/status-pill";
import { CardChat } from "./card-chat";
import { DagPane } from "./dag-pane";
import { PrdPane } from "./prd-pane";
import { ProblemNotice, WorkTimer } from "./card";
import { AGENT_ROLE_LABELS, COLUMN_AGENT_ROLE, type BoardCard, type Prd } from "@/lib/domain/entities";
import { columnFor, isStalled } from "@/lib/domain/status";
import { epicProgress } from "@/lib/domain/stages";

interface EpicDetail {
  epic: BoardCard | null;
  title: string;
  rawRequest: string;
  prd: Prd | null;
  children: BoardCard[];
  /** Its planning stopped, and a person can start it again. */
  canRetry: boolean;
}

const ACTION =
  "border-line rounded border px-1.5 py-0.5 text-[12px] disabled:opacity-50";

/**
 * Dual-pane Epic drawer: the PRD on the left in editorial serif, the child
 * ticket DAG with its file boundaries on the right.
 *
 * Full-screen bottom sheet on mobile, per the responsiveness rules.
 */
export function EpicDrawer({
  epicId,
  onClose,
  onOpenTicket,
  streamingPrd,
}: {
  epicId: string | null;
  onClose: () => void;
  /** Opens one of its tickets in its own view. */
  onOpenTicket?: (ticketId: string) => void;
  /** Live PRD text while the Product Agent writes. */
  streamingPrd?: string;
}) {
  const [detail, setDetail] = useState<EpicDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<"prd" | "dag">("prd");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Another Epic: nothing of the last one's stays on screen.
  const [shownFor, setShownFor] = useState(epicId);
  if (epicId !== shownFor) {
    setShownFor(epicId);
    setDetail(null);
    setFailed(false);
    setConfirming(false);
    setActionError(null);
  }
  const loading = !!epicId && !detail && !failed;

  const load = useCallback(async () => {
    if (!epicId) return;
    return fetch(`/api/epics/${epicId}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<EpicDetail>) : null))
      .then(
        (found) => (found ? setDetail(found) : setFailed(true)),
        () => setFailed(true),
      );
  }, [epicId]);

  // Load on open, and again when the Product Agent finishes writing, so the
  // streamed draft is replaced by the stored document.
  const prdWritten = streamingPrd === "";
  useEffect(() => {
    void load();
  }, [load, prdWritten]);

  // While an agent works on it, look again now and then: its answer may
  // come from GitHub Actions, which streams nothing here.
  const working = !!detail?.epic?.agentRole;
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [working, load]);

  useEffect(() => {
    if (!epicId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [epicId, onClose]);

  const save = useCallback(
    async (prd: Prd) => {
      if (!epicId) return;
      const res = await fetch(`/api/epics/${epicId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prd }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not save the PRD.");
      }
      await load();
    },
    [epicId, load],
  );

  const act = useCallback(
    async (method: "POST" | "DELETE") => {
      if (!epicId) return;
      setBusy(true);
      setActionError(null);
      try {
        const res = await fetch(`/api/epics/${epicId}`, { method });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setActionError(body?.error ?? "That did not work. Try again in a moment.");
          return;
        }
        if (method === "DELETE") onClose();
        else await load();
      } catch {
        setActionError("That did not work. Try again in a moment.");
      } finally {
        setBusy(false);
        setConfirming(false);
      }
    },
    [epicId, load, onClose],
  );

  if (!epicId) return null;

  const epic = detail?.epic;
  const failedAt = epic && isStalled(epic.status) ? epic.stage : null;
  const progress = epic
    ? epicProgress(epic, detail?.children ?? [])
    : { current: 1, working: false };

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Epic detail"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-bg border-line flex h-[92dvh] w-full max-w-5xl flex-col rounded-t-lg border sm:h-[85dvh] sm:rounded-lg"
      >
        <header className="border-line shrink-0 border-b p-4">
          {epic && <ProblemNotice card={epic} className="mb-3" />}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <span className="text-fg-subtle font-mono text-[10px]">
                {epic?.key ?? "EPIC"}
              </span>
              <h2 className="mt-0.5 font-serif text-[18px] leading-tight font-semibold">
                {detail?.title ?? (loading ? "Loading…" : "Epic")}
              </h2>
              {epic && (
                <div className="mt-1 flex items-center gap-2">
                  <StatusPill status={epic.status} />
                  {epic.workingSince && (
                    <span className="text-ochre-text inline-flex items-center gap-1 text-[11px]">
                      Working for <WorkTimer since={epic.workingSince} className="text-ochre-text" />
                    </span>
                  )}
                  {epic.childCount > 0 && (
                    <span className="text-fg-subtle text-[11px]">
                      {epic.doneCount} of {epic.childCount} merged
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {detail?.canRetry && !confirming && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act("POST")}
                  className={cn(ACTION, "text-fg hover:border-line-strong")}
                >
                  Retry
                </button>
              )}
              {epic && !confirming && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                  className={cn(ACTION, "text-fg-muted hover:text-crimson-text")}
                >
                  Delete
                </button>
              )}
              {confirming && (
                <>
                  <span className="text-fg-muted text-[12px]">
                    {epic && epic.childCount > 0
                      ? `Delete it and its ${epic.childCount} ticket${epic.childCount === 1 ? "" : "s"}?`
                      : "Delete it?"}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act("DELETE")}
                    className={cn(ACTION, "bg-crimson text-on-crimson border-transparent")}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirming(false)}
                    className={cn(ACTION, "text-fg-muted hover:text-fg")}
                  >
                    Keep
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-fg-muted hover:text-fg border-line rounded border px-1.5 py-0.5 text-[12px]"
              >
                Close
              </button>
            </div>
          </div>

          {actionError && (
            <p role="alert" className="text-crimson-text mt-2 text-[12px] leading-[1.5]">
              {actionError}
            </p>
          )}

          <StepIndicator
            className="mt-3"
            current={progress.current}
            failedAt={failedAt}
            working={progress.working}
          />
        </header>

        {/* Tabs below the dual-pane breakpoint, where two columns do not fit. */}
        <div className="border-line flex shrink-0 gap-0.5 border-b px-2 py-1 lg:hidden">
          {(["prd", "dag"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-2 py-1 text-[12px] font-medium",
                tab === t ? "bg-amber text-on-amber" : "text-fg-muted",
              )}
            >
              {t === "prd" ? "PRD" : `Tickets (${detail?.children.length ?? 0})`}
            </button>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 lg:grid-cols-2">
          <div
            className={cn(
              "border-line min-h-0 overflow-y-auto lg:border-r",
              tab === "prd" ? "block" : "hidden lg:block",
            )}
          >
            <PrdPane
              prd={detail?.prd ?? null}
              rawRequest={detail?.rawRequest ?? ""}
              streaming={streamingPrd}
              writing={epic?.agentRole === "product"}
              onSave={save}
            />
          </div>

          <div
            className={cn(
              "bg-sunken flex min-h-0 flex-col",
              tab === "dag" ? "flex" : "hidden lg:flex",
            )}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <DagPane
                tickets={detail?.children ?? []}
                onOpen={onOpenTicket && ((t) => onOpenTicket(t.id))}
              />
            </div>
            {epic && (
              <div className="border-line h-[280px] shrink-0 border-t">
                <CardChat
                  kind="epic"
                  cardId={epicId}
                  agentLabel={AGENT_ROLE_LABELS[COLUMN_AGENT_ROLE[columnFor(epic.status, epic.stalledIn)]]}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
