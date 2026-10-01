"use client";

import {
  PATH_RAILS,
  type Budget,
  type LimitMode,
  type LimitSetting,
} from "@/lib/budget/budget-for";

export type Row = { points: string; value: string };

/** What the person has typed for one axis; text until it is validated on save. */
export type AxisDraft = { mode: LimitMode; flat: string; perPoint: string; rows: Row[] };

export type AxisErrors = { mode?: string; flat?: string; perPoint?: string; byHand?: string };

export type AxisId = "time" | "tokens" | "attempts";

export type AxisConfig = {
  id: AxisId;
  title: string;
  question: string;
  /** Plural noun for the amount: "minutes", "tokens", "attempts". */
  unit: string;
  /** How the limit is applied, as budgetFor reports it. */
  enforcement: Budget["enforcement"][keyof Budget["enforcement"]];
  /** The rate Per point uses when none is typed; null when the axis has none. */
  defaultPerPoint: number | null;
  /** Whether the person can type the per-point rate (time uses its fixed default). */
  editableRate: boolean;
  /** Whether a blank Flat value keeps the built-in defaults instead of being an error. */
  blankFlatKeepsDefault?: boolean;
  /** What Off means for this axis, before the hard rail is named. */
  offBlurb: string;
};

const ENFORCEMENT_TEXT: Record<AxisConfig["enforcement"], string> = {
  "between-turns": "Checked between agent turns; the turn in flight finishes first.",
  job: "Applied by the job the agent runs in.",
};

const inputClass =
  "border-line bg-cream text-ink focus:border-clay h-10 rounded-md border px-2.5 text-[13px] outline-none";

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The hard rail that bounds a run whatever the person chooses, from the rails budgetFor clamps to. */
export function hardRailText(): string {
  const rails = Object.entries(PATH_RAILS).map(([path, rail]) => `${path} ${rail.minutes} minutes`);
  return `The hard rail still bounds the run: ${rails.join(", ")}.`;
}

export function toRows(values: Record<number | string, number> | null | undefined): Row[] {
  return Object.entries(values ?? {}).map(([points, value]) => ({ points, value: String(value) }));
}

export function draftFromSetting(setting: LimitSetting): AxisDraft {
  return {
    mode: setting.mode,
    flat: setting.flat != null ? String(setting.flat) : "",
    perPoint: setting.perPoint != null ? String(setting.perPoint) : "",
    rows: toRows(setting.byHand),
  };
}

/** A whole number from the input, or NaN so validation rejects it. */
export function whole(text: string): number {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
}

/** One limit axis: Off, Flat, Per point or Per point by hand, with its enforcement class and the Off message. */
export function LimitAxisSection({
  config,
  draft,
  errors,
  onChange,
}: {
  config: AxisConfig;
  draft: AxisDraft;
  errors: AxisErrors;
  onChange: (draft: AxisDraft) => void;
}) {
  const { id, unit } = config;
  const modes: { mode: LimitMode; label: string; blurb: string }[] = [
    { mode: "OFF", label: "Off", blurb: config.offBlurb },
    { mode: "FLAT", label: "Flat", blurb: `The same number of ${unit} for every ticket.${config.blankFlatKeepsDefault ? " Leave blank to keep the built-in defaults." : ""}`,
    },
    {
      mode: "PER_POINT",
      label: "Per point",
      blurb:
        config.defaultPerPoint != null
          ? `${capitalised(unit)} × story points. Default: ${config.defaultPerPoint.toLocaleString("en-US")} ${unit} per story point.`
          : `${capitalised(unit)} × story points.`,
    },
    {
      mode: "PER_POINT_BY_HAND",
      label: "Per point by hand",
      blurb: `Your own ${unit} for particular story point sizes.`,
    },
  ];

  function setRow(index: number, patch: Partial<Row>) {
    onChange({ ...draft, rows: draft.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-ink mb-1 text-[12px] font-semibold">{config.title}</legend>
      <p className="text-muted text-[12px] leading-[1.5]">{config.question}</p>
      <p className="text-muted text-[12px] leading-[1.5]">Enforcement: {ENFORCEMENT_TEXT[config.enforcement]}</p>
      {modes.map((m) => (
        <label key={m.mode} className="flex items-start gap-2">
          <input
            type="radio"
            name={`limit-${id}-mode`}
            value={m.mode}
            aria-label={m.label}
            aria-describedby={`limit-${id}-${m.mode}-blurb`}
            checked={draft.mode === m.mode}
            onChange={() => onChange({ ...draft, mode: m.mode })}
            className="mt-1"
          />
          <span>
            <span className="text-ink block text-[13px] font-medium">{m.label}</span>
            <span id={`limit-${id}-${m.mode}-blurb`} className="text-muted block text-[12px] leading-[1.5]">
              {m.blurb}
            </span>
          </span>
        </label>
      ))}
      {errors.mode && <p className="text-crimson-text text-[11px]">{errors.mode}</p>}

      {draft.mode === "OFF" && (
        <p role="note" className="text-ink text-[12px] leading-[1.5]">
          {hardRailText()}
        </p>
      )}

      {draft.mode === "FLAT" && (
        <div>
          <label className="text-ink block text-[12px] font-medium" htmlFor={`limit-${id}-flat`}>
            {`${capitalised(unit)} per ticket`}
          </label>
          <input
            id={`limit-${id}-flat`}
            inputMode="numeric"
            value={draft.flat}
            onChange={(e) => onChange({ ...draft, flat: e.target.value })}
            aria-invalid={!!errors.flat}
            aria-describedby={errors.flat ? `limit-${id}-flat-error` : undefined}
            className={`${inputClass} w-28`}
          />
          {errors.flat && (
            <p id={`limit-${id}-flat-error`} className="text-crimson-text mt-1 text-[11px]">
              {errors.flat}
            </p>
          )}
        </div>
      )}

      {draft.mode === "PER_POINT" && config.editableRate && (
        <div>
          <label className="text-ink block text-[12px] font-medium" htmlFor={`limit-${id}-rate`}>
            {`${capitalised(unit)} per story point`}
          </label>
          <input
            id={`limit-${id}-rate`}
            inputMode="numeric"
            value={draft.perPoint}
            onChange={(e) => onChange({ ...draft, perPoint: e.target.value })}
            aria-invalid={!!errors.perPoint}
            aria-describedby={errors.perPoint ? `limit-${id}-rate-error` : undefined}
            className={`${inputClass} w-32`}
          />
          {errors.perPoint && (
            <p id={`limit-${id}-rate-error`} className="text-crimson-text mt-1 text-[11px]">
              {errors.perPoint}
            </p>
          )}
        </div>
      )}

      {draft.mode === "PER_POINT_BY_HAND" && (
        <div className="flex flex-col gap-2">
          {draft.rows.map((row, i) => (
            <div key={i} className="flex items-end gap-2">
              <div>
                <label className="text-ink block text-[12px] font-medium" htmlFor={`limit-${id}-points-${i}`}>
                  Story points (row {i + 1})
                </label>
                <input
                  id={`limit-${id}-points-${i}`}
                  inputMode="numeric"
                  value={row.points}
                  onChange={(e) => setRow(i, { points: e.target.value })}
                  className={`${inputClass} w-24`}
                />
              </div>
              <div>
                <label className="text-ink block text-[12px] font-medium" htmlFor={`limit-${id}-value-${i}`}>
                  {`${capitalised(unit)} (row ${i + 1})`}
                </label>
                <input
                  id={`limit-${id}-value-${i}`}
                  inputMode="numeric"
                  value={row.value}
                  onChange={(e) => setRow(i, { value: e.target.value })}
                  className={`${inputClass} w-24`}
                />
              </div>
              <button
                type="button"
                aria-label={`Remove row ${i + 1}`}
                onClick={() => onChange({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}
                className="text-muted hover:text-ink h-10 px-1 text-[12px] font-medium"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onChange({ ...draft, rows: [...draft.rows, { points: "", value: "" }] })}
            className="text-terracotta self-start text-[12px] font-semibold"
          >
            Add row
          </button>
          {errors.byHand && (
            <p role="alert" className="text-crimson-text text-[11px]">
              {errors.byHand}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
