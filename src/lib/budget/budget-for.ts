/**
 * budgetFor: one pure rule that turns a board's limit settings, a column and a
 * ticket into the minutes, tokens and attempts of a run, so every agent path
 * is bounded the same way. Generalises src/lib/run-time-budget (time only) to
 * three axes with the same four modes. Framework-free on purpose.
 *
 * Precedence: column override > the setting's mode (per point × story points,
 * per point by hand, flat) > Off. A resolved value is clamped under the path's
 * hard rail, and the result says which rail did it.
 */

import {
  DEFAULT_MINUTES_PER_STORY_POINT,
  resolveRunTimeBudget,
} from "@/lib/run-time-budget";

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

export type ProjectLimitSettings = {
  minutes?: LimitSetting | null;
  tokens?: LimitSetting | null;
  attempts?: LimitSetting | null;
};

/** A column's own value for an axis; wins over the project's setting. */
export type ColumnLimits = { minutes?: number | null; tokens?: number | null; attempts?: number | null };

export type TicketForBudget = { storyPoints?: number | null };

export const BUDGET_PATHS = ["in-process", "loop", "cli-job", "job-cap", "sandbox"] as const;
export type BudgetPath = (typeof BUDGET_PATHS)[number];

/** Seconds a serverless route may run, mirrored by the routes' maxDuration. */
const IN_PROCESS_SECONDS = 300;
/** The loop/CLI job's workflow timeout (RUNNER_JOB_MINUTES in the runner). */
const JOB_MINUTES = 60;
/** What a job leaves for cloning, installing and reporting (JOB_HEADROOM_MINUTES). */
const JOB_HEADROOM = 5;
/** GitHub's own maximum for a job. */
const JOB_CAP_MINUTES = 360;
/** Sandbox lifetime (DEFAULT_TTL_MS in src/lib/sandbox/types). */
const SANDBOX_TTL_MINUTES = 20;

export type Enforcement = "between-turns" | "job" | "hard-rail";

/** Hard rails per path, as data. `enforcement` is how the rail is applied when it clamps. */
export const PATH_RAILS: Record<BudgetPath, { minutes: number; enforcement: Enforcement }> = {
  "in-process": { minutes: IN_PROCESS_SECONDS / 60, enforcement: "hard-rail" },
  loop: { minutes: JOB_MINUTES - JOB_HEADROOM, enforcement: "job" },
  "cli-job": { minutes: JOB_MINUTES - JOB_HEADROOM, enforcement: "job" },
  "job-cap": { minutes: JOB_CAP_MINUTES, enforcement: "hard-rail" },
  sandbox: { minutes: SANDBOX_TTL_MINUTES, enforcement: "hard-rail" },
};

/** Today's attempt limits: MAX_REVIEWS, MAX_DECOMPOSITION_ATTEMPTS, DRAFT_ATTEMPTS, CLI_ANSWER_ATTEMPTS. */
export const ATTEMPT_DEFAULTS = { review: 4, decomposition: 3, draft: 2, cliAnswer: 2 } as const;
export type AttemptKind = keyof typeof ATTEMPT_DEFAULTS;

/** Default tokens a story point buys: today's 200¢ run ceiling at the rate below, less headroom. */
export const DEFAULT_TOKENS_PER_STORY_POINT = 64_000;

/** Conservative cents per million tokens; money is derived from tokens, never set. */
const CENTS_PER_MTOK = 2500;

export type Clamp = { rail: BudgetPath; limitMinutes: number; enforcement: Enforcement };

export type Limit = {
  /** What the run is held to; null when unbounded. */
  value: number | null;
  /** What the rule asked for before clamping; null when Off. */
  requested: number | null;
  /** Set when a rail lowered the value (or bounded an Off) — names the rail. */
  clamp: Clamp | null;
};

export type Budget = {
  minutes: Limit;
  tokens: Limit;
  attempts: Limit;
  /** Derived from tokens × a conservative rate; null when tokens are unbounded. */
  maxCents: number | null;
  /** How each limit is enforced. */
  enforcement: { minutes: "between-turns"; tokens: "job"; attempts: "between-turns" };
};

function points(ticket: TicketForBudget): number {
  const p = ticket.storyPoints;
  return p != null && p >= 1 ? p : 1;
}

function positive(n: number | null | undefined): n is number {
  return n != null && n >= 1;
}

function resolveAxis(
  setting: LimitSetting | null | undefined,
  override: number | null | undefined,
  pts: number,
  defaultPerPoint: number | null,
  defaultFlat: number | null,
): number | null {
  if (positive(override)) return override;
  const s = setting ?? { mode: defaultPerPoint != null ? "PER_POINT" : "FLAT" };
  const perPoint = positive(s.perPoint) ? s.perPoint : defaultPerPoint;
  const fallback = perPoint != null ? perPoint * pts : defaultFlat;
  switch (s.mode) {
    case "OFF":
      return null;
    case "FLAT":
      return positive(s.flat) ? s.flat : fallback;
    case "PER_POINT":
      return fallback;
    case "PER_POINT_BY_HAND":
      return s.byHand?.[pts] ?? fallback;
  }
}

function clampMinutes(requested: number | null, path: BudgetPath): Limit {
  const rail = PATH_RAILS[path];
  const clamp: Clamp = { rail: path, limitMinutes: rail.minutes, enforcement: rail.enforcement };
  if (requested == null) return { value: rail.minutes, requested, clamp };
  if (requested > rail.minutes) return { value: rail.minutes, requested, clamp };
  return { value: requested, requested, clamp: null };
}

function unclamped(value: number | null): Limit {
  return { value, requested: value, clamp: null };
}

export function budgetFor(
  settings: ProjectLimitSettings | null | undefined,
  column: ColumnLimits | null | undefined,
  ticket: TicketForBudget,
  path: BudgetPath,
  attemptKind: AttemptKind = "review",
): Budget {
  const pts = points(ticket);

  // Minutes: the same four modes as resolveRunTimeBudget, which stays the rule for them.
  const m = settings?.minutes;
  const minutesRequested = positive(column?.minutes)
    ? column.minutes
    : m == null || m.mode === "PER_POINT" || m.mode === "OFF" || m.mode === "FLAT"
      ? resolveAxis(m, null, pts, DEFAULT_MINUTES_PER_STORY_POINT, null)
      : resolveRunTimeBudget(
          { mode: "PER_POINT", perPointMinutes: m.byHand },
          pts,
        );
  const minutes = clampMinutes(minutesRequested, path);

  const tokensRequested = resolveAxis(
    settings?.tokens,
    column?.tokens,
    pts,
    DEFAULT_TOKENS_PER_STORY_POINT,
    null,
  );
  const tokens = unclamped(tokensRequested);

  const attempts = unclamped(
    resolveAxis(settings?.attempts, column?.attempts, pts, null, ATTEMPT_DEFAULTS[attemptKind]),
  );

  return {
    minutes,
    tokens,
    attempts,
    maxCents: tokens.value == null ? null : Math.ceil((tokens.value / 1_000_000) * CENTS_PER_MTOK),
    enforcement: { minutes: "between-turns", tokens: "job", attempts: "between-turns" },
  };
}
