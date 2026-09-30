import "server-only";

import { repository } from "@/lib/db";
import type { RunTimeBudgetColumns, UserRecord } from "@/lib/db/repository";
import {
  parsePerPointMinutes,
  serialisePerPointMinutes,
  type RunTimeBudgetSettings,
} from "@/lib/run-time-budget";

type BudgetRow = Pick<
  UserRecord,
  "runTimeBudgetMode" | "runTimeBudgetFlatMinutes" | "runTimeBudgetPerPointMinutes"
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
