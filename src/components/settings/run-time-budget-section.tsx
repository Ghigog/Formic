"use client";

import { useState } from "react";
import type { LimitMode, LimitSetting } from "@/lib/budget/budget-for";
import {
  DEFAULT_MINUTES_PER_STORY_POINT,
  DEFAULT_RUN_TIME_BUDGET_SETTINGS,
  validateRunTimeBudgetSettings,
  type RunTimeBudgetMode,
  type RunTimeBudgetSettings,
} from "@/lib/run-time-budget";
import { DEFAULT_LIMIT_SETTINGS, validateLimitSetting } from "@/lib/domain/limit-settings";
import { DEFAULT_TOKENS_PER_STORY_POINT } from "@/lib/budget/budget-for";
import {
  LimitAxisSection,
  draftFromSetting,
  toRows,
  whole,
  type AxisConfig,
  type AxisDraft,
  type AxisErrors,
  type AxisId,
} from "./limit-axis-section";

const TIME_TO_AXIS: Record<RunTimeBudgetMode, LimitMode> = {
  OFF: "OFF",
  FLAT_MINUTES: "FLAT",
  PER_STORY_POINT: "PER_POINT",
  PER_POINT: "PER_POINT_BY_HAND",
};
const AXIS_TO_TIME = Object.fromEntries(
  Object.entries(TIME_TO_AXIS).map(([time, axis]) => [axis, time]),
) as Record<LimitMode, RunTimeBudgetMode>;

const AXES: AxisConfig[] = [
  {
    id: "time",
    title: "Time",
    question: "How long may an agent work on one ticket?",
    unit: "minutes",
    enforcement: "between-turns",
    defaultPerPoint: DEFAULT_MINUTES_PER_STORY_POINT,
    editableRate: false,
    offBlurb: "No time budget.",
  },
  {
    id: "tokens",
    title: "Tokens",
    question: "How many tokens may an agent use on one ticket?",
    unit: "tokens",
    enforcement: "job",
    defaultPerPoint: DEFAULT_TOKENS_PER_STORY_POINT,
    editableRate: true,
    offBlurb: "No token limit.",
  },
  {
    id: "attempts",
    title: "Attempts",
    question: "How many times may an agent retry one step?",
    unit: "attempts",
    enforcement: "between-turns",
    defaultPerPoint: null,
    editableRate: true,
    blankFlatKeepsDefault: true,
    offBlurb: "No attempt limit.",
  },
];

type Drafts = Record<AxisId, AxisDraft>;
type AllErrors = Record<AxisId, AxisErrors>;

function timeDraft(time: RunTimeBudgetSettings): AxisDraft {
  return {
    mode: TIME_TO_AXIS[time.mode],
    flat: time.flatMinutes != null ? String(time.flatMinutes) : "",
    perPoint: "",
    rows: toRows(time.perPointMinutes),
  };
}

const NO_ERRORS: AllErrors = { time: {}, tokens: {}, attempts: {} };

/** The setting a draft says, plus the field errors that stop it saving. */
function build(
  config: AxisConfig,
  draft: AxisDraft,
): { setting: LimitSetting | null; errors: AxisErrors; keepsDefault?: boolean } {
  const errors: AxisErrors = {};
  if (draft.mode === "FLAT" && config.blankFlatKeepsDefault && draft.flat.trim() === "") {
    return { setting: null, errors, keepsDefault: true };
  }
  const setting: LimitSetting = { mode: draft.mode };
  if (draft.mode === "FLAT") setting.flat = whole(draft.flat);
  if (draft.mode === "PER_POINT" && config.editableRate) {
    if (draft.perPoint.trim() !== "") setting.perPoint = whole(draft.perPoint);
    else if (config.defaultPerPoint == null) errors.perPoint = `Enter ${config.unit} per story point.`;
  }
  if (draft.mode === "PER_POINT_BY_HAND") {
    // Keyed by the typed text so duplicates and junk surface as errors, not silent merges.
    const byHand = Object.fromEntries(draft.rows.map((row) => [row.points.trim(), whole(row.value)]));
    if (draft.rows.length === 0) errors.byHand = "Add at least one per-point value.";
    else if (Object.keys(byHand).length < draft.rows.length) {
      errors.byHand = "Each story point size can appear only once.";
    }
    setting.byHand = byHand as unknown as Record<number, number>;
  }
  if (config.id === "time") {
    const found = validateRunTimeBudgetSettings(
      { mode: AXIS_TO_TIME[draft.mode], flatMinutes: setting.flat },
      setting.byHand as Record<string, unknown> | undefined,
    );
    if (found.flatMinutes) errors.flat = found.flatMinutes;
    if (found.perPointMinutes && !errors.byHand) errors.byHand = found.perPointMinutes;
  } else {
    const found = validateLimitSetting(setting);
    for (const key of ["mode", "flat", "perPoint", "byHand"] as const) {
      if (found[key] && !errors[key]) errors[key] = found[key];
    }
  }
  return { setting: Object.keys(errors).length ? null : setting, errors };
}

/** Server field errors, keyed `flatMinutes`/`perPointMinutes` for time and `tokens.flat` and so on, back to each axis. */
function serverErrors(raw: Record<string, string> | undefined): AllErrors {
  const out: AllErrors = { time: {}, tokens: {}, attempts: {} };
  for (const [key, message] of Object.entries(raw ?? {})) {
    if (key === "flatMinutes") out.time.flat = message;
    else if (key === "perPointMinutes") out.time.byHand = message;
    else if (key === "mode") out.time.mode = message;
    else {
      const [axis, field] = key.split(".");
      if (axis === "tokens" || axis === "attempts") out[axis][field as keyof AxisErrors] = message;
    }
  }
  return out;
}

/** The limits on a run: time, tokens and attempts, each with its own mode and values, saved together. */
export function RunTimeBudgetSection({
  initial = DEFAULT_RUN_TIME_BUDGET_SETTINGS,
  tokens = DEFAULT_LIMIT_SETTINGS.tokens,
  attempts = DEFAULT_LIMIT_SETTINGS.attempts,
}: {
  initial?: RunTimeBudgetSettings;
  tokens?: LimitSetting;
  attempts?: LimitSetting;
}) {
  const [drafts, setDrafts] = useState<Drafts>({
    time: timeDraft(initial),
    tokens: draftFromSetting(tokens),
    attempts: draftFromSetting(attempts),
  });
  const [errors, setErrors] = useState<AllErrors>(NO_ERRORS);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setMessage(null);
    const built = AXES.map((config) => ({ config, ...build(config, drafts[config.id]) }));
    const found: AllErrors = { time: {}, tokens: {}, attempts: {} };
    for (const b of built) found[b.config.id] = b.errors;
    setErrors(found);
    if (built.some((b) => b.setting == null && !b.keepsDefault)) return;
    const [time, tokenSetting, attemptSetting] = built.map((b) => b.setting);
    if (!time || !tokenSetting) return;

    setBusy(true);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: AXIS_TO_TIME[time.mode],
        flatMinutes: time.mode === "FLAT" ? time.flat : null,
        perPointMinutes: time.mode === "PER_POINT_BY_HAND" ? time.byHand : null,
        tokens: tokenSetting,
        // Left out when it keeps the built-in defaults, so what is stored stays as it was.
        ...(attemptSetting ? { attempts: attemptSetting } : {}),
      }),
    }).catch(() => null);
    setBusy(false);
    const body = (await res?.json().catch(() => null)) as
      | { error?: string; errors?: Record<string, string> }
      | null;
    if (!res?.ok) {
      setErrors(serverErrors(body?.errors));
      setMessage({ ok: false, text: body?.error ?? "That did not save. Try again." });
      return;
    }
    setMessage({ ok: true, text: "Limits saved." });
  }

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">Limits</h2>
      <form
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {AXES.map((config) => (
          <LimitAxisSection
            key={config.id}
            config={config}
            draft={drafts[config.id]}
            errors={errors[config.id]}
            onChange={(draft) => setDrafts((current) => ({ ...current, [config.id]: draft }))}
          />
        ))}

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
