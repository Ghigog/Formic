/**
 * Run time budget: the person's chosen mode plus a ticket's story points
 * resolve to a number of minutes per attempt, or to no budget at all.
 * See docs/run-time-budgets.md. Framework-free on purpose.
 */

export const RUN_TIME_BUDGET_MODES = [
  "OFF",
  "FLAT_MINUTES",
  "PER_STORY_POINT",
  "PER_POINT",
] as const;

export type RunTimeBudgetMode = (typeof RUN_TIME_BUDGET_MODES)[number];

export const DEFAULT_MINUTES_PER_STORY_POINT = 10;

/** Minutes by story points, e.g. { 1: 5, 2: 15 }. */
export type PerPointMinutes = Record<number, number>;

export type RunTimeBudgetSettings = {
  mode: RunTimeBudgetMode;
  /** Used by FLAT_MINUTES. */
  flatMinutes?: number | null;
  /** Used by PER_POINT. */
  perPointMinutes?: PerPointMinutes | null;
};

/** What a person with no explicit setting gets. */
export const DEFAULT_RUN_TIME_BUDGET_SETTINGS: RunTimeBudgetSettings = {
  mode: "PER_STORY_POINT",
};

/** Minutes for one run, or null when no per-run time budget applies (off). */
export type RunTimeBudgetMinutes = number | null;

function effectivePoints(storyPoints: number | null | undefined): number {
  return storyPoints != null && storyPoints >= 1 ? storyPoints : 1;
}

export function resolveRunTimeBudget(
  settings: RunTimeBudgetSettings | null | undefined,
  storyPoints: number | null | undefined,
): RunTimeBudgetMinutes {
  const { mode, flatMinutes, perPointMinutes } =
    settings ?? DEFAULT_RUN_TIME_BUDGET_SETTINGS;
  const points = effectivePoints(storyPoints);
  const perStoryPoint = points * DEFAULT_MINUTES_PER_STORY_POINT;
  switch (mode) {
    case "OFF":
      return null;
    case "FLAT_MINUTES":
      return flatMinutes != null && flatMinutes >= 1
        ? flatMinutes
        : perStoryPoint;
    case "PER_STORY_POINT":
      return perStoryPoint;
    case "PER_POINT":
      return perPointMinutes?.[points] ?? perStoryPoint;
  }
}

/** Serialise per-point values to the JSON stored on the user. */
export function serialisePerPointMinutes(values: PerPointMinutes): string {
  return JSON.stringify(values);
}

/** Parse stored per-point JSON; null when missing, malformed or not a map of positive numbers. */
export function parsePerPointMinutes(
  raw: string | null | undefined,
): PerPointMinutes | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const out: PerPointMinutes = {};
  for (const [key, value] of Object.entries(data)) {
    const points = Number(key);
    if (!Number.isInteger(points) || points < 1) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return null;
    }
    out[points] = value;
  }
  return out;
}

export type RunTimeBudgetErrors = {
  flatMinutes?: string;
  perPointMinutes?: string;
};

/** Field-level messages; an empty object means the settings are valid. */
export function validateRunTimeBudgetSettings(
  settings: RunTimeBudgetSettings,
  rawPerPoint?: Record<string, unknown> | null,
): RunTimeBudgetErrors {
  const errors: RunTimeBudgetErrors = {};
  if (settings.mode === "FLAT_MINUTES") {
    const m = settings.flatMinutes;
    if (m == null || !Number.isFinite(m) || m < 1) {
      errors.flatMinutes = "Flat minutes must be at least 1.";
    }
  }
  if (settings.mode === "PER_POINT") {
    const entries = Object.entries(
      rawPerPoint ?? settings.perPointMinutes ?? {},
    );
    if (entries.length === 0) {
      errors.perPointMinutes = "Add at least one per-point value.";
    } else if (entries.some(([k]) => !/^\d+$/.test(k) || Number(k) < 1)) {
      errors.perPointMinutes =
        "Story points must be whole numbers of at least 1.";
    } else if (
      entries.some(
        ([, v]) => typeof v !== "number" || !Number.isInteger(v) || v < 1,
      )
    ) {
      errors.perPointMinutes = "Minutes must be whole numbers of at least 1.";
    }
  }
  return errors;
}
