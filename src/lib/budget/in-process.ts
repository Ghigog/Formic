import "server-only";

import { budgetFor, type BudgetPath, type Budget, type ColumnLimits } from "./budget-for";
import { resolveRunTimeBudget } from "@/lib/run-time-budget";
import { getLimitSettings, getRunTimeBudgetSettings } from "@/lib/user-settings";

/**
 * What a ticket's run is held to on a path: the owner's settings for minutes,
 * tokens and attempts, resolved for the ticket's story points, the column's
 * own values winning, and clamped under the path's rail. Read once, when the
 * run starts.
 */
export async function budgetForRun(
  ownerId: string | null,
  ticket: { storyPoints?: number | null },
  path: BudgetPath,
  column: ColumnLimits | null = null,
): Promise<Budget> {
  if (!ownerId) return budgetFor(null, column, ticket, path);
  const [limits, minutes] = await Promise.all([getLimitSettings(ownerId), getRunTimeBudgetSettings(ownerId)]);
  const resolved = resolveRunTimeBudget(minutes, ticket.storyPoints);
  return budgetFor(
    {
      ...limits,
      minutes: resolved == null ? { mode: "OFF" } : { mode: "FLAT", flat: resolved },
    },
    column,
    ticket,
    path,
  );
}

/** A ticket's in-process run: the same rule, under the in-process rail. */
export function inProcessBudget(
  ownerId: string | null,
  ticket: { storyPoints?: number | null },
): Promise<Budget> {
  return budgetForRun(ownerId, ticket, "in-process");
}
