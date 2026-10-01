import "server-only";

import { budgetFor, type Budget } from "./budget-for";
import { resolveRunTimeBudget } from "@/lib/run-time-budget";
import { getLimitSettings, getRunTimeBudgetSettings } from "@/lib/user-settings";

/**
 * What a ticket's in-process run is held to: the owner's settings for
 * minutes, tokens and attempts, resolved for the ticket's story points and
 * clamped under the in-process rail. Read once, when the run starts.
 */
export async function inProcessBudget(
  ownerId: string | null,
  ticket: { storyPoints?: number | null },
): Promise<Budget> {
  if (!ownerId) return budgetFor(null, null, ticket, "in-process");
  const [limits, minutes] = await Promise.all([getLimitSettings(ownerId), getRunTimeBudgetSettings(ownerId)]);
  const resolved = resolveRunTimeBudget(minutes, ticket.storyPoints);
  return budgetFor(
    {
      ...limits,
      minutes: resolved == null ? { mode: "OFF" } : { mode: "FLAT", flat: resolved },
    },
    null,
    ticket,
    "in-process",
  );
}
