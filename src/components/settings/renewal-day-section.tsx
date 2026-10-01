"use client";

import { useState } from "react";

export interface Renewal {
  day: number | null;
  timezone: string | null;
}

/** The day of the month this person's plan renews; empty means none. */
export function RenewalDaySection({ initial }: { initial?: Renewal }) {
  const [day, setDay] = useState(initial?.day != null ? String(initial.day) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setMessage(null);
    const text = day.trim();
    const renewalDay = text === "" ? null : /^\d+$/.test(text) ? Number(text) : NaN;
    if (renewalDay !== null && !(renewalDay >= 1 && renewalDay <= 31)) {
      setError("Enter a whole day from 1 to 31.");
      return;
    }
    setError(null);
    setBusy(true);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ renewalDay, timezone }),
    }).catch(() => null);
    setBusy(false);
    const body = (await res?.json().catch(() => null)) as
      | { error?: string; errors?: { renewalDay?: string } }
      | null;
    if (!res?.ok) {
      setError(body?.errors?.renewalDay ?? body?.error ?? "That did not save. Try again.");
      return;
    }
    setMessage(renewalDay === null ? "Renewal day removed." : "Renewal day saved.");
  }

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">
        Plan renewal
      </h2>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <label className="text-ink block text-[12px] font-medium" htmlFor="renewal-day">
            Renewal day
          </label>
          <p className="text-muted mb-1 text-[12px] leading-[1.5]">
            The day of the month your plan renews, so Formic can tell how much of the month is left.
            Leave empty if you don&apos;t know.
          </p>
          <input
            id="renewal-day"
            inputMode="numeric"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? "renewal-day-error" : undefined}
            className="border-line bg-cream text-ink focus:border-clay h-10 w-28 rounded-md border px-2.5 text-[13px] outline-none"
          />
          {error && (
            <p id="renewal-day-error" role="alert" className="text-crimson-text mt-1 text-[11px]">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="bg-terracotta-cta h-10 rounded-lg px-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {message && (
            <p role="status" className="text-muted text-[11px]">
              {message}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
