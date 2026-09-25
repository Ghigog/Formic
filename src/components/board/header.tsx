"use client";

import { useState } from "react";
import { CoinBadge } from "@/components/ui/coin-badge";
import { RepoPicker } from "./repo-picker";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { AccountMenu, type Account } from "./account-menu";
import { AskBox, AskButton, type AssistantControls } from "./assistant";
import { ColonyHeaderStats, ColonyMobileStats } from "@/components/colony/header-stats";
import type { CaptureColumn } from "./new-item-dialog";

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
 * moved, the assistant, and the colony: level, points, heat and the way into
 * the timeline. New work starts from the Backlog's own button.
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
  onNewItem,
  account,
  assistant,
}: {
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  inSync: boolean;
  /** Relative time since the last fetch, e.g. "2m". */
  syncedLabel?: string;
  /** The mobile app bar's CTA. Always opens Backlog's dialog; on a wide screen, Backlog has its own. */
  onNewItem: (column: CaptureColumn) => void;
  account?: Account;
  /** The board's assistant. Omitted, the header has no ask box. */
  assistant?: AssistantControls;
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
      <header className="border-line bg-card relative z-[2] hidden h-16 shrink-0 items-center gap-4 border-b px-6 md:flex">
        <div className="flex items-center gap-[10px]">
          <LogoMark size={28} />
          <span className="font-serif text-[19px] font-semibold tracking-[-0.01em]">
            Formic
          </span>
        </div>

        <span aria-hidden className="bg-line h-6 w-px" />

        <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setPicker((v) => !v)}
          aria-expanded={picker}
          aria-label={`Project: ${projectName}. Choose another project`}
          className="border-line bg-cream text-ink inline-flex h-[34px] items-center gap-2 rounded-lg border px-[10px] text-[13px] font-medium whitespace-nowrap"
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
          outerClassName="shrink-0 max-lg:hidden"
          title={inSync ? "Base branch in sync" : "Base branch has moved ahead"}
          className="text-ink px-[10px] py-[5px] text-[10px] tracking-[0.04em]"
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${inSync ? "bg-jade" : "bg-rust"}`}
          />
          {sync}
        </CoinBadge>

        <div className="flex min-w-0 flex-1 justify-center">
          {assistant && !isMobile && <AskBox a={assistant} repoName={repo ?? repoFullName} />}
        </div>

        <ColonyHeaderStats />
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
          <span className="text-muted inline-flex max-w-full items-center gap-[5px] overflow-hidden font-mono text-[9px] whitespace-nowrap">
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
        <ColonyMobileStats />
        {assistant && isMobile && <AskButton a={assistant} repoName={repo ?? repoFullName} />}
        <button
          type="button"
          onClick={() => onNewItem("backlog")}
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
