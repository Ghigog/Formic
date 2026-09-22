"use client";

import { CoinBadge } from "@/components/ui/coin-badge";
import { ProgressBar } from "@/components/ui/progress-bar";

export function BoardHeader({
  projectName,
  repoFullName,
  baseBranch,
  inSync,
  epicsTotal,
  epicsDone,
  onNewItem,
}: {
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  inSync: boolean;
  epicsTotal: number;
  epicsDone: number;
  onNewItem: () => void;
}) {
  return (
    <header className="border-line bg-surface/95 sticky top-0 z-30 border-b backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <h1 className="text-fg text-[14px] font-semibold tracking-tight">
          Formic
        </h1>

        <span className="text-fg-subtle" aria-hidden>
          /
        </span>

        <button
          type="button"
          className="text-fg hover:border-line-strong border-line rounded border px-1.5 py-0.5 text-[12px] font-medium"
        >
          {projectName}
        </button>

        <a
          href={`https://github.com/${repoFullName}`}
          target="_blank"
          rel="noreferrer"
          className="text-fg-muted hover:text-amber-text font-mono text-[11px]"
        >
          {repoFullName}
        </a>

        <CoinBadge
          tone={inSync ? "jade" : "rust"}
          filled={!inSync}
          title={inSync ? "Base branch in sync" : "Base branch has moved ahead"}
        >
          {baseBranch}
        </CoinBadge>

        <div className="ml-auto flex items-center gap-2">
          {epicsTotal > 0 && (
            <div className="hidden w-32 items-center gap-1 sm:flex">
              <span className="text-fg-subtle text-[10px] whitespace-nowrap">
                {epicsDone}/{epicsTotal} epics
              </span>
              <ProgressBar
                value={epicsDone / epicsTotal}
                tone="jade"
                label="Epic completion"
              />
            </div>
          )}

          <button
            type="button"
            onClick={onNewItem}
            className="bg-amber text-on-amber rounded px-2 py-1 text-[12px] font-semibold transition-opacity hover:opacity-90"
          >
            New Backlog Item
          </button>
        </div>
      </div>
    </header>
  );
}
