"use client";

import { useState } from "react";
import { CoinBadge } from "@/components/ui/coin-badge";
import { ProgressBar } from "@/components/ui/progress-bar";
import { RepoPicker } from "./repo-picker";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { AccountMenu, type Account } from "./account-menu";

function LogoMark({ size }: { size: 26 | 28 }) {
  return (
    <span
      aria-hidden
      className="oct-lg bg-anthracite text-cream inline-flex items-center justify-center font-serif font-semibold"
      style={{ width: size, height: size, fontSize: size === 28 ? 16 : 15 }}
    >
      F
    </span>
  );
}

function PlusIcon({ size = 12 }: { size?: 12 | 16 }) {
  const big = size === 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox={big ? "0 0 16 16" : "0 0 12 12"}
      fill="none"
      aria-hidden="true"
    >
      <path
        d={big ? "M8 3.5v9M3.5 8h9" : "M6 2.5v7M2.5 6h7"}
        stroke="currentColor"
        strokeWidth={big ? 1.8 : 1.6}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The 64px board header: who you are looking at, whether the base branch has
 * moved, how far the epics have got, and the one primary action.
 *
 * Below 768px it collapses to a 56px app bar — project and branch stacked,
 * the CTA reduced to a 44px icon button.
 */
export function BoardHeader({
  projectName,
  repoFullName,
  baseBranch,
  inSync,
  syncedLabel,
  epicsTotal,
  epicsDone,
  onNewItem,
  account,
}: {
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  inSync: boolean;
  /** Relative time since the last fetch, e.g. "2m". */
  syncedLabel?: string;
  epicsTotal: number;
  epicsDone: number;
  onNewItem: () => void;
  account?: Account;
}) {
  const [owner, repo] = repoFullName.split("/");
  const [picker, setPicker] = useState(false);
  // One picker mounted at a time, in whichever header is showing.
  const isMobile = useMediaQuery("(max-width: 767px)");
  const sync = inSync
    ? `${baseBranch} · synced${syncedLabel ? ` ${syncedLabel}` : ""}`
    : `${baseBranch} · behind`;

  return (
    <>
      {/* Desktop */}
      <header className="border-line bg-card hidden h-16 shrink-0 items-center gap-4 border-b px-6 md:flex">
        <div className="flex items-center gap-[10px]">
          <LogoMark size={28} />
          <span className="font-serif text-[19px] font-semibold tracking-[-0.01em]">
            Formic
          </span>
        </div>

        <span aria-hidden className="bg-line h-6 w-px" />

        <div className="relative">
        <button
          type="button"
          onClick={() => setPicker((v) => !v)}
          aria-expanded={picker}
          aria-label={`Project: ${projectName}. Choose another project`}
          className="border-line bg-cream text-ink inline-flex h-[34px] items-center gap-2 rounded-lg border px-[10px] text-[13px] font-medium"
        >
          {owner} / {repo}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 4.5 6 7.5 9 4.5"
              stroke="var(--text-muted)"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {picker && !isMobile && (
          <RepoPicker
            current={repoFullName}
            onClose={() => setPicker(false)}
            className="absolute top-full left-0 mt-2"
          />
        )}
        </div>

        <CoinBadge
          ground="cream"
          title={inSync ? "Base branch in sync" : "Base branch has moved ahead"}
          className="text-ink px-[10px] py-[5px] text-[10px] tracking-[0.04em]"
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${inSync ? "bg-jade" : "bg-rust"}`}
          />
          {sync}
        </CoinBadge>

        <div className="flex-grow" />

        {epicsTotal > 0 && (
          <div className="flex items-center gap-[10px]">
            <span className="text-muted text-[11px] font-semibold tracking-[0.06em] uppercase">
              Epic progress
            </span>
            <ProgressBar
              value={epicsDone / epicsTotal}
              label="Epic progress"
              height={6}
              track="bg-line"
              className="w-[148px]"
            />
            <span className="text-ink font-mono text-[11px] tabular-nums">
              {epicsDone}/{epicsTotal}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={onNewItem}
          className="bg-terracotta-cta inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          <PlusIcon />
          New backlog item
        </button>
        {account && <AccountMenu account={account} />}
      </header>

      {/* Mobile app bar */}
      <header className="border-line bg-card flex h-14 shrink-0 items-center gap-[10px] border-b px-4 md:hidden">
        <LogoMark size={26} />
        <button
          type="button"
          onClick={() => setPicker((v) => !v)}
          aria-label={`Project: ${projectName}. Choose another project`}
          className="flex min-h-11 min-w-0 flex-col justify-center gap-px text-left"
        >
          <span className="truncate text-[13px] font-semibold">{repo} ▾</span>
          <span className="text-muted inline-flex items-center gap-[5px] font-mono text-[9px]">
            <span
              aria-hidden
              className={`size-[5px] rounded-full ${inSync ? "bg-jade" : "bg-rust"}`}
            />
            {sync}
          </span>
        </button>
        {picker && isMobile && (
          <RepoPicker
            current={repoFullName}
            onClose={() => setPicker(false)}
            className="fixed top-14 left-4"
          />
        )}
        <div className="flex-grow" />
        <button
          type="button"
          onClick={onNewItem}
          aria-label="New backlog item"
          className="bg-terracotta-cta inline-flex size-11 items-center justify-center rounded-[10px] text-white"
        >
          <PlusIcon size={16} />
        </button>
        {account && <AccountMenu account={account} />}
      </header>
    </>
  );
}
