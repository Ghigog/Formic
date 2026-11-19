"use client";

import { useState } from "react";

/**
 * Whether this project has everything the levels unlock, without earning the
 * colony XP first: every Sentinel, board feature (Timeline, KPIs, Playtest),
 * bug shape and colour. The colony rules (reserve, scouts) still follow the
 * level, since they change how many agents run. Stored as unlockAllSentinels.
 */
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
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">Unlocks</h2>
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        Sentinels, Timeline, KPIs, Playtest and bug styles unlock as the colony earns XP. A project that already has a
        long history can skip the climb and have them all now. How many agents run at once still follows your level.
      </p>
      <label className="text-ink flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void change(e.target.checked)} />
        Unlock everything
      </label>
      {error && (
        <p role="alert" className="text-crimson-text mt-1 text-[11px]">
          {error}
        </p>
      )}
    </section>
  );
}
