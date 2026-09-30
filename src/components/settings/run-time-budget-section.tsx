"use client";

import { useState } from "react";
import {
  DEFAULT_MINUTES_PER_STORY_POINT,
  DEFAULT_RUN_TIME_BUDGET_SETTINGS,
  validateRunTimeBudgetSettings,
  type RunTimeBudgetErrors,
  type RunTimeBudgetMode,
  type RunTimeBudgetSettings,
} from "@/lib/run-time-budget";

const MODES: { mode: RunTimeBudgetMode; label: string; blurb: string }[] = [
  {
    mode: "OFF",
    label: "Off",
    blurb: "No time budget. Runs are bounded only by what the platform allows.",
  },
  { mode: "FLAT_MINUTES", label: "Flat minutes", blurb: "The same number of minutes for every ticket." },
  {
    mode: "PER_STORY_POINT",
    label: "Per story point",
    blurb: `Minutes × story points. Default: ${DEFAULT_MINUTES_PER_STORY_POINT} minutes per story point.`,
  },
  {
    mode: "PER_POINT",
    label: "Per-point values",
    blurb: "Your own minutes for particular story point sizes.",
  },
];

type Row = { points: string; minutes: string };
type FieldErrors = RunTimeBudgetErrors & { mode?: string };

const inputClass =
  "border-line bg-cream text-ink focus:border-clay h-10 rounded-md border px-2.5 text-[13px] outline-none";

function toRows(values: RunTimeBudgetSettings["perPointMinutes"]): Row[] {
  return Object.entries(values ?? {}).map(([points, minutes]) => ({
    points,
    minutes: String(minutes),
  }));
}

/** A whole number from the input, or NaN so validation rejects it. */
function whole(text: string): number {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
}

/** How long a run may last: the mode, and the minutes that mode uses. */
export function RunTimeBudgetSection({
  initial = DEFAULT_RUN_TIME_BUDGET_SETTINGS,
}: {
  initial?: RunTimeBudgetSettings;
}) {
  const [mode, setMode] = useState(initial.mode);
  const [flat, setFlat] = useState(initial.flatMinutes != null ? String(initial.flatMinutes) : "");
  const [rows, setRows] = useState<Row[]>(toRows(initial.perPointMinutes));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function setRow(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function save() {
    setMessage(null);
    const flatMinutes = mode === "FLAT_MINUTES" ? whole(flat) : null;
    // Keyed by the typed text so duplicates and junk surface as errors, not silent merges.
    const perPoint =
      mode === "PER_POINT"
        ? Object.fromEntries(rows.map((row) => [row.points.trim(), whole(row.minutes)]))
        : null;
    const found: FieldErrors = validateRunTimeBudgetSettings(
      { mode, flatMinutes },
      perPoint,
    );
    if (perPoint && !found.perPointMinutes && Object.keys(perPoint).length < rows.length) {
      found.perPointMinutes = "Each story point size can appear only once.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, flatMinutes, perPointMinutes: perPoint }),
    }).catch(() => null);
    setBusy(false);
    const body = (await res?.json().catch(() => null)) as
      | { error?: string; errors?: FieldErrors }
      | null;
    if (!res?.ok) {
      setErrors(body?.errors ?? {});
      setMessage({ ok: false, text: body?.error ?? "That did not save. Try again." });
      return;
    }
    setMessage({ ok: true, text: "Run time budget saved." });
  }

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">
        Run time budget
      </h2>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="text-muted mb-1 text-[12px] leading-[1.5]">
            How long may an agent work on one ticket?
          </legend>
          {MODES.map((m) => (
            <label key={m.mode} className="flex items-start gap-2">
              <input
                type="radio"
                name="run-time-budget-mode"
                value={m.mode}
                checked={mode === m.mode}
                onChange={() => setMode(m.mode)}
                className="mt-1"
              />
              <span>
                <span className="text-ink block text-[13px] font-medium">{m.label}</span>
                <span className="text-muted block text-[12px] leading-[1.5]">{m.blurb}</span>
              </span>
            </label>
          ))}
          {errors.mode && <p className="text-crimson-text text-[11px]">{errors.mode}</p>}
        </fieldset>

        {mode === "FLAT_MINUTES" && (
          <div>
            <label className="text-ink block text-[12px] font-medium" htmlFor="run-time-budget-flat">
              Minutes per ticket
            </label>
            <input
              id="run-time-budget-flat"
              inputMode="numeric"
              value={flat}
              onChange={(e) => setFlat(e.target.value)}
              aria-invalid={!!errors.flatMinutes}
              aria-describedby={errors.flatMinutes ? "run-time-budget-flat-error" : undefined}
              className={`${inputClass} w-28`}
            />
            {errors.flatMinutes && (
              <p id="run-time-budget-flat-error" className="text-crimson-text mt-1 text-[11px]">
                {errors.flatMinutes}
              </p>
            )}
          </div>
        )}

        {mode === "PER_POINT" && (
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-end gap-2">
                <div>
                  <label className="text-ink block text-[12px] font-medium" htmlFor={`run-time-budget-points-${i}`}>
                    Story points (row {i + 1})
                  </label>
                  <input
                    id={`run-time-budget-points-${i}`}
                    inputMode="numeric"
                    value={row.points}
                    onChange={(e) => setRow(i, { points: e.target.value })}
                    className={`${inputClass} w-24`}
                  />
                </div>
                <div>
                  <label className="text-ink block text-[12px] font-medium" htmlFor={`run-time-budget-minutes-${i}`}>
                    Minutes (row {i + 1})
                  </label>
                  <input
                    id={`run-time-budget-minutes-${i}`}
                    inputMode="numeric"
                    value={row.minutes}
                    onChange={(e) => setRow(i, { minutes: e.target.value })}
                    className={`${inputClass} w-24`}
                  />
                </div>
                <button
                  type="button"
                  aria-label={`Remove row ${i + 1}`}
                  onClick={() => setRows((current) => current.filter((_, j) => j !== i))}
                  className="text-muted hover:text-ink h-10 px-1 text-[12px] font-medium"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRows((current) => [...current, { points: "", minutes: "" }])}
              className="text-terracotta self-start text-[12px] font-semibold"
            >
              Add row
            </button>
            {errors.perPointMinutes && (
              <p role="alert" className="text-crimson-text text-[11px]">
                {errors.perPointMinutes}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="bg-terracotta-cta h-10 rounded-lg px-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {message && (
            <p
              role="status"
              className={`text-[11px] ${message.ok ? "text-muted" : "text-crimson-text"}`}
            >
              {message.text}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
