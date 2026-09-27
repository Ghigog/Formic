"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { RunnerSetup } from "@/lib/runner/setup";

/** A column whose CLI agent has no key yet: it cannot run until it has one. */
export interface KeylessAgent {
  name: string;
  keyName: string;
  onAdd: () => void;
}

/**
 * The one thing a person has to do before agents can run in their
 * repository: merge the pull request that installs Formic's workflow. Shown
 * as the board loads, not as a card's error once they have already asked an
 * agent for something. It closes itself when the merge lands.
 */
export function SetupDialog({
  setup,
  repoName,
  keyless,
  onRetry,
}: {
  setup: RunnerSetup | null;
  repoName: string;
  keyless: KeylessAgent[];
  onRetry: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const titleId = useId();
  const primary = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const open = !!setup && setup.state !== "ready" && !hidden;

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => primary.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHidden(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!setup || setup.state === "ready") return null;

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setHidden(false)}
        className="bg-card border-line text-ink fixed bottom-16 left-4 z-50 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium shadow-sm"
      >
        <span aria-hidden className="bg-clay pulse-dot size-1.5 rounded-full" />
        {setup.state === "waiting" ? "Setup pull request waiting" : "Agents can't run yet"}
      </button>
    );
  }

  const title =
    setup.state === "blocked"
      ? `Formic can't set up ${repoName} yet`
      : setup.update
        ? "Formic's agent workflow changed"
        : `Getting ${repoName} ready`;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-[color-mix(in_srgb,var(--anthracite)_32%,transparent)] p-0 backdrop-blur-[3px] motion-safe:animate-[reqFade_160ms_ease-out] sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        className="bg-card border-line box-border flex w-full max-w-[480px] flex-col gap-4 rounded-t-xl border p-5 shadow-[0_30px_60px_-24px_color-mix(in_srgb,var(--anthracite)_45%,transparent)] motion-safe:animate-[reqPop_240ms_cubic-bezier(.2,.9,.3,1.15)] sm:rounded-xl"
      >
        <h2 id={titleId} className="text-ink m-0 text-[16px] font-semibold">
          {title}
        </h2>

        {setup.state === "blocked" ? (
          <p className="text-muted m-0 text-[13px] leading-[1.6]">{setup.reason}</p>
        ) : (
          <>
            <p className="text-muted m-0 text-[13px] leading-[1.6]">
              {setup.update
                ? `Merge this update to ${repoName} so its agents keep running.`
                : "Agents run in this repository's own GitHub Actions. That takes one workflow file, which you merge yourself because it runs with the repository's secrets."}
            </p>
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-[13px]">
              <Step n={1} label="Merge the setup pull request">
                <a
                  ref={primary}
                  href={setup.setupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-terracotta-cta inline-flex h-[30px] items-center rounded-lg px-3 text-[12px] font-semibold whitespace-nowrap text-white hover:opacity-90"
                >
                  Open pull request ↗
                </a>
              </Step>
              {keyless.map((agent, i) => (
                <Step key={agent.name} n={i + 2} label={`Add a ${agent.keyName} to ${agent.name}`}>
                  <button
                    type="button"
                    onClick={agent.onAdd}
                    className="border-line bg-card text-ink h-[30px] rounded-lg border px-3 text-[12px] font-medium whitespace-nowrap"
                  >
                    Add key
                  </button>
                </Step>
              ))}
            </ol>
            {!setup.update && (
              <p className="text-muted m-0 text-[12px] leading-[1.6]">
                Your first ticket is waiting in To Do: an AGENTS.md that tells every agent how this codebase is
                built and tested. Start it once the pull request is merged.
              </p>
            )}
          </>
        )}

        <div className="flex items-center gap-2">
          {setup.state === "waiting" && (
            <span className="text-muted flex items-center gap-1.5 text-[11px]">
              <span aria-hidden className="bg-clay pulse-dot size-1.5 rounded-full" />
              Watching for the merge
            </span>
          )}
          <div className="flex-grow" />
          {setup.state === "blocked" && (
            <button
              ref={primary}
              type="button"
              onClick={onRetry}
              className="bg-terracotta-cta h-[34px] rounded-lg px-3.5 text-[13px] font-semibold text-white hover:opacity-90"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => setHidden(true)}
            className="border-line bg-card text-ink h-[34px] rounded-lg border px-3 text-[13px] font-medium active:scale-[0.96]"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <li className="border-line flex items-center gap-3 rounded-lg border px-3 py-2">
      <span className="bg-cream text-muted inline-flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[11px]">
        {n}
      </span>
      <span className="text-ink flex-1">{label}</span>
      {children}
    </li>
  );
}
