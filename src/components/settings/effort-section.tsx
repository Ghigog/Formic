"use client";

import { useState } from "react";

/** Whether a coding run's thinking effort follows its ticket's story points. */
export function EffortSection({ initial = true }: { initial?: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effortByPoints: next }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError("That did not save. Try again.");
      return;
    }
    setOn(next);
  }

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">
        Thinking effort
      </h2>
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        Coders and reviewers think briefly on small tickets and thoroughly on
        large ones: low for 1–2 points, medium for 3–5, high for 8 and up. An
        escalated ticket thinks harder with its new points. Off, every run
        thinks at medium.
      </p>
      <label className="text-ink flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => void change(e.target.checked)}
        />
        Match effort to story points
      </label>
      {error && (
        <p role="alert" className="text-crimson-text mt-1 text-[11px]">
          {error}
        </p>
      )}
    </section>
  );
}
