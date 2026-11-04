"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { SENTINELS, isUnlocked } from "@/lib/sentinels/roster";
import { useSentinels } from "./store";

/** Whether the offer still applies: some Sentinel is locked and nothing has settled it yet. */
export function shouldOfferUnlockAll(opts: {
  established: boolean;
  level: number;
  unlockAll: boolean;
  dismissedAt: string | null;
}): boolean {
  if (!opts.established || opts.unlockAll || opts.dismissedAt) return false;
  return !SENTINELS.every((s) => isUnlocked(s, opts.level, false));
}

/**
 * Offered once per project when its history is long enough to count as
 * established and some Sentinel is still locked. The dismissal is kept on the
 * project, so no other device asks again. It only points at the Settings
 * toggle; the owner switches it on there.
 */
export function UnlockAllDialog({ projectId, unlockAll }: { projectId: string; unlockAll: boolean }) {
  const level = useSentinels()?.level ?? 0;
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (unlockAll) return;
    let live = true;
    void fetch(`/api/projects/${projectId}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{
            established?: boolean;
            unlockAllSentinels?: boolean;
            unlockAllOfferDismissedAt?: string | null;
          }>) : null))
      .then((body) => {
        if (
          live &&
          body &&
          shouldOfferUnlockAll({
            established: !!body.established,
            level,
            unlockAll: !!body.unlockAllSentinels,
            dismissedAt: body.unlockAllOfferDismissedAt ?? null,
          })
        ) {
          setOpen(true);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, unlockAll, level]);

  const dismiss = () => {
    void fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unlockAllOfferDismissed: true }),
    }).catch(() => {});
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-[color-mix(in_srgb,var(--anthracite)_32%,transparent)] p-0 backdrop-blur-[3px] motion-safe:animate-[reqFade_160ms_ease-out] sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        className="bg-card border-line box-border flex w-full max-w-[420px] flex-col gap-4 rounded-t-xl border p-5 shadow-[0_30px_60px_-24px_color-mix(in_srgb,var(--anthracite)_45%,transparent)] motion-safe:animate-[reqPop_240ms_cubic-bezier(.2,.9,.3,1.15)] sm:rounded-xl"
      >
        <h2 id={titleId} className="text-ink m-0 text-[16px] font-semibold">
          This project has a long history
        </h2>
        <p className="text-muted m-0 text-[13px] leading-[1.6]">
          All Sentinels can be unlocked in Settings, without earning the colony XP first.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="text-muted hover:text-ink h-[30px] px-3 text-[12px] font-medium"
          >
            Not now
          </button>
          <Link
            href="/settings#sentinels"
            onClick={dismiss}
            className="bg-terracotta-cta inline-flex h-[30px] items-center rounded-lg px-3 text-[12px] font-semibold whitespace-nowrap text-white hover:opacity-90"
          >
            Open Settings
          </Link>
        </div>
      </div>
    </div>
  );
}
