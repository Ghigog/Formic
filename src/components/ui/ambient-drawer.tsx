"use client";

import { useState } from "react";
import { cn } from "./cn";
import { CoinBadge } from "./coin-badge";

export interface AmbientStats {
  activeSandboxes: number;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  /** Most recent log lines across all live runs. */
  logLines: Array<{ runId: string; stream: "stdout" | "stderr"; line: string }>;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * The persistent bottom bar: what the colony is doing right now, and what it
 * is costing. Collapsed by default; expands into a terminal view of the live
 * git and test streams.
 */
export function AmbientDrawer({
  stats,
  onStopAll,
}: {
  stats: AmbientStats;
  onStopAll?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const busy = stats.activeSandboxes > 0;

  return (
    <div className="border-line bg-surface/95 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur">
      {open && (
        <div className="bg-sunken border-line max-h-56 overflow-y-auto border-b p-2">
          {stats.logLines.length === 0 ? (
            <p className="text-fg-subtle font-mono text-[11px]">
              No agents running.
            </p>
          ) : (
            <pre className="font-mono text-[11px] leading-5 whitespace-pre-wrap">
              {stats.logLines.map((l, i) => (
                <div
                  key={`${l.runId}-${i}`}
                  className={
                    l.stream === "stderr" ? "text-crimson-text" : "text-fg-muted"
                  }
                >
                  <span className="text-fg-subtle">
                    {l.runId.slice(0, 7)}{" "}
                  </span>
                  {l.line}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 px-2 py-1.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            busy ? "bg-ochre animate-pulse" : "bg-line-strong",
          )}
        />
        <span className="text-[11px] font-medium">
          {busy
            ? `${stats.activeSandboxes} agent${stats.activeSandboxes === 1 ? "" : "s"} active`
            : "Colony idle"}
        </span>
        <CoinBadge tone="neutral" title="Sandbox provider">
          {stats.provider}
        </CoinBadge>

        <span className="text-fg-subtle ml-auto font-mono text-[10px] tabular-nums">
          {compact(stats.tokensIn)} in · {compact(stats.tokensOut)} out ·{" "}
          {money(stats.costCents)}
        </span>

        {busy && onStopAll && (
          <button
            type="button"
            onClick={onStopAll}
            className="border-crimson text-crimson-text hover:bg-crimson hover:text-on-crimson rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors"
          >
            Stop all
          </button>
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="text-fg-muted hover:text-fg border-line rounded border px-1.5 py-0.5 text-[11px] font-medium"
        >
          {open ? "Hide terminal" : "Terminal"}
        </button>
      </div>
    </div>
  );
}
