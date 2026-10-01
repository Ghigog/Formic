"use client";

import { useState } from "react";
import { RepoPicker } from "./repo-picker";
import { useAssistantActivity } from "@/lib/hooks/use-assistant-activity";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { AccountMenu, type Account } from "./account-menu";
import { AskBox, AskButton, type AssistantControls } from "./assistant";
import { ColonyHeaderStats, ColonyLevelStats, ColonyMobileStats } from "@/components/colony/header-stats";

/**
 * The 64px board header: the project, the assistant, and the colony: level
 * centred, then points, heat and the way into the timeline. New work starts
 * from the Backlog's own button.
 *
 * Below 768px it collapses to a 56px app bar.
 */
export function BoardHeader({
  projectName,
  repoFullName,
  account,
  assistant,
}: {
  projectName: string;
  repoFullName: string;
  account?: Account;
  /** The board's assistant. Omitted, the header has no ask box. */
  assistant?: AssistantControls;
}) {
  const [owner, repo] = repoFullName.split("/");
  const [picker, setPicker] = useState(false);
  const activity = useAssistantActivity();
  const unseenBadge = activity.count > 0 && (
    <button
      type="button"
      onClick={() => setPicker(true)}
      aria-label={`${activity.count} other ${activity.count === 1 ? "project has" : "projects have"} a new assistant answer`}
      className="bg-terracotta inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
    >
      {activity.count}
    </button>
  );
  // One picker mounted at a time, in whichever header is showing.
  const isMobile = useMediaQuery("(max-width: 767px)");

  return (
    <>
      {/* Desktop */}
      <header className="border-line bg-card relative z-[2] hidden h-16 shrink-0 items-center gap-4 border-b px-6 md:flex">
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
        {!isMobile && unseenBadge}

        <div className="flex min-w-0 flex-1 justify-center">
          {assistant && !isMobile && <AskBox a={assistant} repoName={repo ?? repoFullName} />}
        </div>

        <div className="absolute left-1/2 -translate-x-1/2">
          <ColonyLevelStats />
        </div>
        <ColonyHeaderStats showLevel={false} />
        {account && <AccountMenu account={account} />}
      </header>

      {/* Mobile app bar */}
      <header className="border-line bg-card flex h-14 shrink-0 items-center gap-[10px] border-b px-4 md:hidden">
        <button
          type="button"
          onClick={() => setPicker((v) => !v)}
          aria-label={`Project: ${projectName}. Choose another project`}
          className="flex min-h-11 min-w-0 flex-col justify-center gap-px text-left"
        >
          <span className="truncate text-[13px] font-semibold">{repo} ▾</span>
        </button>
        {picker && isMobile && (
          <RepoPicker
            current={repoFullName}
            onClose={() => setPicker(false)}
            className="fixed top-14 left-4"
          />
        )}
        {isMobile && unseenBadge}
        <div className="flex-grow" />
                <ColonyMobileStats />
        {assistant && isMobile && <AskButton a={assistant} repoName={repo ?? repoFullName} />}
        {account && <AccountMenu account={account} />}
      </header>
    </>
  );
}
