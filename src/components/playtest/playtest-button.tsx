"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { useColony } from "@/components/colony/colony";
import { FeatureReveal } from "@/components/colony/feature-reveal";
import { useCountdown } from "@/lib/hooks/use-countdown";
import { usePlaytest } from "./playtest-context";
import { isOpen } from "./types";

export function PlayIcon({ size = 12 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 12 12" fill="currentColor">
      <path d="M3 1.8v8.4a.6.6 0 0 0 .92.5l6.5-4.2a.6.6 0 0 0 0-1L3.92 1.3A.6.6 0 0 0 3 1.8Z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2.2" y="5.2" width="7.6" height="5.6" rx="1.2" />
      <path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4" />
    </svg>
  );
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Playtest, in the Done column where the other columns have their agent.
 * Hidden until the board reaches its level; grayed, with the reason, when
 * this person cannot use it yet. See docs/plans/playtest.md.
 */
export function PlaytestButton() {
  const colony = useColony();
  const p = usePlaytest();
  const [why, setWhy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const running = isOpen(p?.session);
  const left = useCountdown(running && p?.session?.status === "live" ? p.session.endsAt : null);

  useEffect(() => {
    if (!why) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setWhy(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setWhy(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [why]);

  if (!colony || !p || (!colony.featureUnlocked("playtest") && colony.revealing !== "playtest")) return null;

  const blocked = p.access && !p.access.ok ? p.access : null;
  const settingsLink = blocked?.reason === "no-key" || blocked?.reason === "no-repo-access";
  const tour = blocked?.reason === "no-key" ? "playtest playtest-key" : "playtest";

  return (
    <div ref={root} className="relative">
      <FeatureReveal reveal={colony.revealing === "playtest"} sound={colony.sound} onSettled={colony.settleReveal}>
        <button
          type="button"
          data-tour={tour}
          aria-disabled={!!blocked || p.access === null || undefined}
          aria-expanded={blocked ? why : undefined}
          onClick={() => {
            if (p.access === null) return;
            if (blocked) setWhy((w) => !w);
            else p.open();
          }}
          className={cn(
            "flex h-11 w-full items-center gap-1.5 rounded-md border px-2 text-left text-[11px] transition-colors md:h-8",
            blocked || p.access === null
              ? "bg-column border-line text-muted cursor-default"
              : "bg-card border-line text-ink hover:border-clay",
          )}
        >
          <span className={cn("shrink-0", blocked ? "text-muted" : "text-jade")}>
            <PlayIcon />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">Playtest</span>
          {running ? (
            <span className="text-muted flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums">
              <span aria-hidden className="bg-jade pulse-dot size-1.5 rounded-full" />
              {left !== null ? `${mmss(left)} left` : "starting"}
            </span>
          ) : blocked ? (
            <span className="shrink-0">
              <LockIcon />
            </span>
          ) : (
            <span className="text-muted shrink-0 font-mono text-[10px]">default branch</span>
          )}
        </button>
      </FeatureReveal>
      {why && blocked && (
        <div
          role="dialog"
          aria-label="Why Playtest is not ready"
          className="bg-card border-line shadow-lift absolute top-full right-0 left-0 z-50 mt-1 rounded-lg border p-3"
        >
          <p className="text-ink m-0 text-[12px] leading-snug">{blocked.message}</p>
          {settingsLink && (
            <Link
              href="/settings#sandbox"
              className="bg-cta mt-2.5 inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-semibold text-white"
            >
              Open Settings
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
