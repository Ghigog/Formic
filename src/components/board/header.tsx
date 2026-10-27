"use client";

import { useState } from "react";
import { RepoPicker } from "./repo-picker";
import { useAssistantActivity } from "@/lib/hooks/use-assistant-activity";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { AccountMenu, type Account } from "./account-menu";
import { AskBox, AskButton, type AssistantControls } from "./assistant";
import {
  ColonyHeaderStats,
  ColonyLevelStats,
  ColonyMobileStats,
} from "@/components/colony/header-stats";

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
  onOpenArchive,
}: {
  projectName: string;
  repoFullName: string;
  account?: Account;
  /** The board's assistant. Omitted, the header has no ask box. */
  assistant?: AssistantControls;
  /** Opens the Archived view. Omitted, the header has no Archived button. */
  onOpenArchive?: () => void;
}) {
  const [, repo] = repoFullName.split("/");
  const [picker, setPicker] = useState(false);
  const activity = useAssistantActivity();
  const label = `Project: ${projectName}. Choose another project${
    activity.count > 0
      ? `. ${activity.count} other ${activity.count === 1 ? "project has" : "projects have"} something new`
      : ""
  }`;
  const toggle = () => setPicker((v) => !v);
  // One picker mounted at a time, in whichever header is showing.
  const isMobile = useMediaQuery("(max-width: 767px)");

  return (
    <>
      {/* Desktop */}
      <header className="border-line bg-card relative z-[2] hidden h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b px-6 md:grid">
        <div className="flex min-w-0 items-center gap-4">
          <div className="relative shrink-0">
            <LogoButton
              count={activity.count}
              onClick={toggle}
              expanded={picker}
              label={label}
              title={repoFullName}
              className="size-[34px]"
            />
            {picker && !isMobile && (
              <RepoPicker
                current={repoFullName}
                onClose={() => setPicker(false)}
                className="absolute top-full left-0 mt-2"
              />
            )}
          </div>

          <div className="flex min-w-0 flex-1">
            {assistant && !isMobile && (
              <AskBox a={assistant} repoName={repo ?? repoFullName} />
            )}
          </div>
        </div>

        <ColonyLevelStats />
        <div className="flex items-center justify-end gap-4">
          {onOpenArchive && (
            <button
              type="button"
              onClick={onOpenArchive}
              className="border-line text-ink rounded-md border px-2.5 py-1 text-[13px]"
            >
              Archived
            </button>
          )}
          <ColonyHeaderStats showLevel={false} />
          {account && <AccountMenu account={account} />}
        </div>
      </header>

      {/* Mobile app bar */}
      <header className="border-line bg-card flex h-14 shrink-0 items-center gap-[10px] border-b px-4 md:hidden">
        <LogoButton
          count={activity.count}
          onClick={toggle}
          expanded={picker}
          label={label}
          title={repoFullName}
          className="min-h-11 min-w-11"
        />
        {picker && isMobile && (
          <RepoPicker
            current={repoFullName}
            onClose={() => setPicker(false)}
            className="fixed top-14 left-4"
          />
        )}
        {assistant && isMobile && (
          <AskButton a={assistant} repoName={repo ?? repoFullName} />
        )}
        <div className="flex-grow" />
        {onOpenArchive && (
          <button type="button" onClick={onOpenArchive} className="border-line text-ink min-h-11 rounded-md border px-2.5 text-[13px]">
            Archived
          </button>
        )}
        <ColonyMobileStats />
        {account && <AccountMenu account={account} />}
      </header>
    </>
  );
}

/** The Formic mark (src/app/icon.svg), with a count badge for other projects' unseen answers. */
function LogoButton({
  count,
  onClick,
  expanded,
  label,
  title,
  className,
}: {
  count: number;
  onClick: () => void;
  expanded: boolean;
  label: string;
  title: string;
  className: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label={label}
      title={title}
      data-tour="logo"
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
    >
      <span className="relative inline-flex">
        <svg
          width="28"
          height="28"
          viewBox="0 0 28 28"
          aria-hidden="true"
          data-testid="formic-logo"
        >
          <polygon
            points="9,0 19,0 28,9 28,19 19,28 9,28 0,19 0,9"
            fill="#1c1917"
          />
          <path
            fill="#fbf9f5"
            d="M 16.28 12.52 V 14.49 V 16.45 H 15.61 L 15.44 14.91 H 11.92 V 14.07 H 15.44 L 15.61 12.52 Z
                 M 17.38 9 H 17.55 L 18.11 12.34 L 17.71 12.43 L 16.22 10.01 L 17.11 10.29 H 11.77 V 9.45 H 16.48 Z
                 M 12.94 9.45 V 18.76 L 14.06 19.19 V 19.5 H 9.89 V 19.19 L 11.01 18.76 V 10.19 L 9.89 9.76 V 9.45 Z"
          />
        </svg>
        {count > 0 && (
          <span className="bg-terracotta absolute -top-1.5 -right-2 inline-flex size-4 items-center justify-center rounded-full text-[10px] font-semibold text-white">
            {count}
          </span>
        )}
      </span>
    </button>
  );
}
