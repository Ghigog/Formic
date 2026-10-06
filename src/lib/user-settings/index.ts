import "server-only";

import { repository } from "@/lib/db";
import type { RunTimeBudgetColumns, UserRecord } from "@/lib/db/repository";
import type { LimitSetting } from "@/lib/budget/budget-for";
import { limitSettingFromStored, type LimitAxis } from "@/lib/domain/limit-settings";
import {
  parsePerPointMinutes,
  serialisePerPointMinutes,
  type RunTimeBudgetSettings,
} from "@/lib/run-time-budget";

type BudgetRow = Pick<
  UserRecord,
  | "runTimeBudgetMode"
  | "runTimeBudgetFlatMinutes"
  | "runTimeBudgetPerPointMinutes"
  | "runTimeBudgetPerPointRate"
>;

/** Row to domain. Only the fields the mode uses are set. */
export function runTimeBudgetFromRow(row: BudgetRow): RunTimeBudgetSettings {
  const perPoint =
    row.runTimeBudgetPerPointMinutes == null
      ? null
      : parsePerPointMinutes(JSON.stringify(row.runTimeBudgetPerPointMinutes));
  return {
    mode: row.runTimeBudgetMode,
    flatMinutes: row.runTimeBudgetFlatMinutes,
    perPointRate: row.runTimeBudgetPerPointRate,
    perPointMinutes: perPoint,
  };
}

/** Domain to row. Values the mode does not use are cleared. */
export function runTimeBudgetToRow(settings: RunTimeBudgetSettings): RunTimeBudgetColumns {
  const perPoint =
    settings.mode === "PER_POINT" && settings.perPointMinutes
      ? (JSON.parse(serialisePerPointMinutes(settings.perPointMinutes)) as Record<string, number>)
      : null;
  return {
    runTimeBudgetMode: settings.mode,
    runTimeBudgetFlatMinutes: settings.mode === "FLAT_MINUTES" ? (settings.flatMinutes ?? null) : null,
    runTimeBudgetPerPointMinutes: perPoint,
    runTimeBudgetPerPointRate:
      settings.mode === "PER_STORY_POINT" ? (settings.perPointRate ?? null) : null,
  };
}

export type LimitSettings = Record<LimitAxis, LimitSetting>;

/** Tokens and attempts as stored; a missing value is the default, Off is returned as Off. */
export async function getLimitSettings(userId: string): Promise<LimitSettings> {
  const row = await repository().userById(userId);
  if (!row) throw new Error(`No user ${userId}.`);
  return {
    tokens: limitSettingFromStored("tokens", row.tokenLimit),
    attempts: limitSettingFromStored("attempts", row.attemptLimit),
  };
}

/** Stores already-validated settings for the axes given; returns all of them. */
export async function updateLimitSettings(
  userId: string,
  input: Partial<LimitSettings>,
): Promise<LimitSettings> {
  const row = await repository().updateLimits(userId, {
    ...(input.tokens ? { tokenLimit: { ...input.tokens } } : {}),
    ...(input.attempts ? { attemptLimit: { ...input.attempts } } : {}),
  });
  return {
    tokens: limitSettingFromStored("tokens", row.tokenLimit),
    attempts: limitSettingFromStored("attempts", row.attemptLimit),
  };
}

export async function getRunTimeBudgetSettings(userId: string): Promise<RunTimeBudgetSettings> {
  const row = await repository().userById(userId);
  if (!row) throw new Error(`No user ${userId}.`);
  return runTimeBudgetFromRow(row);
}

/** Stores already-validated settings; returns what was stored. */
export async function updateRunTimeBudgetSettings(
  userId: string,
  input: RunTimeBudgetSettings,
): Promise<RunTimeBudgetSettings> {
  const row = await repository().updateRunTimeBudget(userId, runTimeBudgetToRow(input));
  return runTimeBudgetFromRow(row);
}
