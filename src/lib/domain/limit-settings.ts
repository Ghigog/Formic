/**
 * The token and attempt limit settings a person stores: defaults, and
 * validation of what arrives. Money is never a setting; cents derive from
 * tokens (see budgetFor), so a cents field is rejected.
 */

export const LIMIT_MODES = ["OFF", "FLAT", "PER_POINT", "PER_POINT_BY_HAND"] as const;
export type LimitMode = (typeof LIMIT_MODES)[number];

export type LimitSetting = {
  mode: LimitMode;
  /** FLAT: the same value for every ticket. */
  flat?: number | null;
  /** PER_POINT: value per story point; the default rate when absent. */
  perPoint?: number | null;
  /** PER_POINT_BY_HAND: values by story points, e.g. { 1: 5, 2: 15 }. */
  byHand?: Record<number, number> | null;
};

/**
 * Actual tokens a story point buys. A real token count, not a money figure in
 * disguise: it is set to what a one-point coding loop actually consumes. A loop
 * re-sends its system prompt, tool schemas and the whole conversation on every
 * turn (the provider bills those input tokens for real), so a ticket whose
 * deliverable is only a few thousand tokens of new text costs a few hundred
 * thousand tokens of cumulative input plus output across its turns. 250,000 is
 * a conservative floor a small ticket clears and a runaway loop still trips.
 */
export const DEFAULT_TOKENS_PER_STORY_POINT = 250_000;

export const LIMIT_AXES = ["tokens", "attempts"] as const;
export type LimitAxis = (typeof LIMIT_AXES)[number];

/** What a person with no stored setting gets. Attempts keep today's per-kind constants. */
export const DEFAULT_LIMIT_SETTINGS: Record<LimitAxis, LimitSetting> = {
  tokens: { mode: "PER_POINT", perPoint: DEFAULT_TOKENS_PER_STORY_POINT },
  attempts: { mode: "FLAT" },
};

/** Days an agent's token allowance is measured over when none is chosen (rolling). */
export const DEFAULT_ALLOWANCE_WINDOW_DAYS = 30;

const MAX_WINDOW_DAYS = 366;

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/** A stored value to a setting; a missing one is the default. */
export function limitSettingFromStored(axis: LimitAxis, stored: unknown): LimitSetting {
  if (stored == null || typeof stored !== "object") return DEFAULT_LIMIT_SETTINGS[axis];
  return stored as LimitSetting;
}

/** Field errors for one axis; empty when valid. */
export function validateLimitSetting(setting: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) return { mode: "Choose a valid mode." };
  const s = setting as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!["mode", "flat", "perPoint", "byHand"].includes(key)) errors[key] = "Not a limit field; money is not a setting.";
  }
  if (!LIMIT_MODES.includes(s.mode as never)) errors.mode = "Choose a valid mode.";
  if (s.flat != null && !isCount(s.flat)) errors.flat = "Use a whole number of at least 1.";
  if (s.perPoint != null && !isCount(s.perPoint)) errors.perPoint = "Use a whole number of at least 1.";
  if (s.byHand != null) {
    const by = s.byHand;
    const ok =
      typeof by === "object" &&
      !Array.isArray(by) &&
      Object.entries(by as object).every(([k, v]) => isCount(Number(k)) && isCount(v));
    if (!ok) errors.byHand = "Use story points mapped to whole numbers of at least 1.";
  }
  if (s.mode === "FLAT" && s.flat == null && errors.flat === undefined) errors.flat = "Enter a flat value.";
  return errors;
}

/** A per-agent allowance: tokens per window, window in whole days. Null tokens clears it. */
export function validateAllowance(tokens: unknown, windowDays: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (tokens != null && !isCount(tokens)) errors.tokens = "Use a whole number of at least 1.";
  if (windowDays != null && !(isCount(windowDays) && windowDays <= MAX_WINDOW_DAYS)) {
    errors.windowDays = `Use a whole number of days from 1 to ${MAX_WINDOW_DAYS}.`;
  }
  return errors;
}
