"use client";

import { useState } from "react";

/** Whether this project has every Sentinel unlocked, without earning the colony XP first. */
export function SentinelsSection({ projectId, initial }: { projectId: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unlockAllSentinels: next }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError("That did not save. Try again.");
      return;
    }
    setOn(next);
  }

  return (
    <section id="sentinels" className="bg-card border-line scroll-mt-4 rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">Sentinels</h2>
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        Sentinels unlock as the colony earns XP. A project that already has a long history can skip the climb and have
        all twelve now.
      </p>
      <label className="text-ink flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void change(e.target.checked)} />
        Unlock all Sentinels
      </label>
      {error && (
        <p role="alert" className="text-crimson-text mt-1 text-[11px]">
          {error}
        </p>
      )}
    </section>
  );
}
