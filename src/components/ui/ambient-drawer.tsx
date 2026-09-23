"use client";

import { useState } from "react";
import { cn } from "./cn";

export interface AmbientStats {
  activeSandboxes: number;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  /** Tokens per second across live runs. Null until a run reports one. */
  throughput?: number | null;
  /** Tickets waiting on the merge queue. */
  queueDepth?: number;
  /** The PR currently holding the merge lock, if any. */
  mergeLockPr?: number | null;
  /** Most recent log lines across all live runs. */
  logLines: Array<{ runId: string; stream: "stdout" | "stderr"; line: string }>;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function Divider() {
  return <span aria-hidden className="bg-drawer-line h-5 w-px shrink-0" />;
}

function LiveDots({ count = 3 }: { count?: number }) {
  return (
    <span aria-hidden className="inline-flex gap-[3px]">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="bg-clay-lit pulse-dot size-[5px] rounded-full"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      className={cn("transition-transform", open && "rotate-180")}
    >
      <path
        d="M3 7.5 6 4.5 9 7.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The ambient agent drawer: a 56px anthracite bar pinned to the bottom of
 * every screen. What the colony is doing right now, what it is costing, and
 * where the merge lock sits — always visible, never in the way.
 *
 * Collapses to icon plus count below 768px.
 */
export function AmbientDrawer({
  stats,
  onStopAll,
  bugsSquashed,
  nest,
}: {
  stats: AmbientStats;
  onStopAll?: () => void;
  /** Bugs handed to the agents so far. Omitted, the bar does not count them. */
  bugsSquashed?: number;
  /** The colony's nest, at the bar's end. */
  nest?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const busy = stats.activeSandboxes > 0;
  const tokens = stats.tokensIn + stats.tokensOut;
  const provider = stats.provider.toUpperCase();

  return (
    <footer className="bg-anthracite text-log-text shrink-0">
      {open && (
        <div className="border-drawer-line max-h-56 overflow-y-auto border-b px-6 py-3">
          {stats.logLines.length === 0 ? (
            <p className="text-drawer-muted font-mono text-[11px]">
              No agents running.
            </p>
          ) : (
            <pre className="font-mono text-[11px] leading-[1.6] whitespace-pre-wrap">
              {stats.logLines.map((l, i) => (
                <div
                  key={`${l.runId}-${i}`}
                  className={
                    l.stream === "stderr" ? "text-log-error" : "text-log-text"
                  }
                >
                  <span className="text-drawer-muted">{l.runId.slice(0, 7)} </span>
                  {l.line}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {/* Desktop */}
      <div className="hidden h-14 items-center gap-5 px-6 md:flex">
        <div className="flex items-center gap-2">
          {busy ? (
            <LiveDots />
          ) : (
            <span aria-hidden className="bg-drawer-line size-[5px] rounded-full" />
          )}
          <span className="text-cream text-[12px] font-semibold">
            {busy
              ? `${stats.activeSandboxes} agent${stats.activeSandboxes === 1 ? "" : "s"} active in ${provider}`
              : "Colony idle"}
          </span>
        </div>

        <Divider />
        <span className="text-drawer-muted font-mono text-[11px]">
          {compact(tokens)} tokens
          {stats.throughput ? ` · ${compact(stats.throughput)} tok/s` : ""}
        </span>

        <Divider />
        <span
          className="text-drawer-muted font-mono text-[11px]"
          title={stats.mergeLockPr ? `Merge lock held by PR #${stats.mergeLockPr}` : "Merge lock free"}
        >
          {stats.queueDepth ?? 0} in merge queue
          {stats.mergeLockPr ? ` · lock PR #${stats.mergeLockPr}` : ""}
        </span>

        {bugsSquashed !== undefined && (
          <>
            <Divider />
            <span className="text-drawer-muted font-mono text-[11px]">
              {bugsSquashed === 1 ? "1 bug squashed" : `${bugsSquashed} bugs squashed`}
            </span>
          </>
        )}

        <div className="flex-grow" />

        {/*
          Not in the artboard. It is the budget kill switch from PROT-12, and
          the ambient bar is the only surface that is always on screen.
        */}
        {busy && onStopAll && (
          <button
            type="button"
            onClick={onStopAll}
            className="border-drawer-line text-log-error hover:bg-log-error/10 h-8 rounded-lg border px-3 font-mono text-[11px] transition-colors"
          >
            Stop all
          </button>
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="border-drawer-line text-cream hover:bg-drawer-line/50 inline-flex h-8 items-center gap-2 rounded-lg border px-3 font-mono text-[11px] transition-colors"
        >
          Terminal
          <Chevron open={open} />
        </button>
        {nest}
      </div>

      {/* Mobile: icon and count only. */}
      <div className="flex h-14 items-center gap-[10px] px-4 md:hidden">
        {busy ? (
          <LiveDots />
        ) : (
          <span aria-hidden className="bg-drawer-line size-[5px] rounded-full" />
        )}
        <span className="text-cream text-[12px] font-semibold">
          {busy ? `${stats.activeSandboxes} agents active` : "Colony idle"}
        </span>
        <div className="flex-grow" />
        <span className="text-drawer-muted font-mono text-[10px]">
          {compact(tokens)} tok
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse agent drawer" : "Expand agent drawer"}
          className="text-cream inline-flex size-11 items-center justify-center"
        >
          <Chevron open={open} />
        </button>
        {nest}
      </div>
    </footer>
  );
}
