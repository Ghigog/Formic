"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { StepIndicator } from "@/components/ui/step-indicator";
import { StatusPill } from "@/components/ui/status-pill";
import { DagPane } from "./dag-pane";
import { PrdPane } from "./prd-pane";
import type { BoardCard, Prd } from "@/lib/domain/entities";
import { isStalled } from "@/lib/domain/status";
import { epicProgress } from "@/lib/domain/stages";

interface EpicDetail {
  epic: BoardCard | null;
  title: string;
  rawRequest: string;
  prd: Prd | null;
  children: BoardCard[];
}

/**
 * Dual-pane Epic drawer: the PRD on the left in editorial serif, the child
 * ticket DAG with its file boundaries on the right.
 *
 * Full-screen bottom sheet on mobile, per the responsiveness rules.
 */
export function EpicDrawer({
  epicId,
  onClose,
  streamingPrd,
}: {
  epicId: string | null;
  onClose: () => void;
  /** Live PRD text while the Product Agent writes. */
  streamingPrd?: string;
}) {
  const [detail, setDetail] = useState<EpicDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"prd" | "dag">("prd");

  const load = useCallback(async () => {
    if (!epicId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/epics/${epicId}`, { cache: "no-store" });
      if (res.ok) setDetail((await res.json()) as EpicDetail);
    } finally {
      setLoading(false);
    }
  }, [epicId]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  // Reload when the Product Agent finishes writing, so the streamed draft is
  // replaced by the stored document.
  useEffect(() => {
    if (streamingPrd === "") void load();
  }, [streamingPrd, load]);

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
                  {epic.childCount > 0 && (
                    <span className="text-fg-subtle text-[11px]">
                      {epic.doneCount} of {epic.childCount} merged
                    </span>
                  )}
                </div>
              )}
            </div>
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
              onSave={save}
            />
          </div>

          <div
            className={cn(
              "bg-sunken min-h-0 overflow-y-auto",
              tab === "dag" ? "block" : "hidden lg:block",
            )}
          >
            <DagPane children={detail?.children ?? []} />
          </div>
        </div>
      </div>
    </div>
  );
}
