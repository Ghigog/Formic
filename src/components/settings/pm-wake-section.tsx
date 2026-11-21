"use client";

import { useState } from "react";

import { PM_WAKE_RANGE, type PmWakeLimits } from "@/lib/domain/pm-wake";

const PM_WAKE_FIELDS: ReadonlyArray<{ key: keyof PmWakeLimits; label: string }> = [
  { key: "fixCap", label: "Fix attempts per stuck ticket" },
  { key: "perHour", label: "Wake-ups per hour" },
  { key: "perDay", label: "Wake-ups per day (UTC)" },
];

/** The PM's wake-up limits for one board (docs/limits.md); each saves when it loses focus. */
export function PmWakeLimitsFields({ projectId, limits }: { projectId: string; limits: PmWakeLimits }) {
  const [values, setValues] = useState(limits);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(key: keyof PmWakeLimits, raw: string) {
    const [min, max] = PM_WAKE_RANGE[key];
    const next = Number(raw);
    if (!Number.isInteger(next) || next < min || next > max) {
      setError(`Pick a whole number from ${min} to ${max}.`);
      return;
    }
    if (next === values[key]) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, pmWakeLimits: { [key]: next } }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError("That did not save. Try again.");
      return;
    }
    setValues((v) => ({ ...v, [key]: next }));
  }

  return (
    <div className="flex flex-col gap-2">
      {PM_WAKE_FIELDS.map(({ key, label }) => (
        <label key={key} className="text-ink flex items-center justify-between gap-3 text-[13px]">
          {label}
          <input
            type="number"
            inputMode="numeric"
            min={PM_WAKE_RANGE[key][0]}
            max={PM_WAKE_RANGE[key][1]}
            defaultValue={values[key]}
            disabled={busy}
            aria-label={label}
            onBlur={(e) => void save(key, e.target.value)}
            className="border-line text-ink w-20 rounded-md border px-2 py-1 text-right text-[12px] disabled:opacity-60"
          />
        </label>
      ))}
      {error && <p className="text-crimson-text text-[11px]">{error}</p>}
    </div>
  );
}
