"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";

const dismissedKey = (projectId: string) => `formic:unlock-all-sentinels:${projectId}`;

function wasDismissed(projectId: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(projectId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Offered once per project when its history is long enough to count as
 * established and every Sentinel is still not unlocked. It only points at the
 * Settings toggle; the owner switches it on there.
 */
export function UnlockAllDialog({ projectId, unlockAll }: { projectId: string; unlockAll: boolean }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (unlockAll || wasDismissed(projectId)) return;
    let live = true;
    void fetch(`/api/projects/${projectId}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ established?: boolean; unlockAllSentinels?: boolean }>) : null))
      .then((body) => {
        if (live && body?.established && !body.unlockAllSentinels) setOpen(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, unlockAll]);

  const dismiss = () => {
    try {
      localStorage.setItem(dismissedKey(projectId), "1");
    } catch {}
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
