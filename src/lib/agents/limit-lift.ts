import "server-only";

import { publish } from "@/lib/events/bus";
import { clearKeyLimited } from "./presets";

/**
 * Work on `presetId` just reached its model and came back: lifts any
 * out-of-usage mark on its account (see clearKeyLimited) and tells the board.
 * Never throws: a failed lift is not a reason to fail the work that proved it.
 */
export async function workedOn(projectId: string, presetId: string | null | undefined): Promise<void> {
  if (!presetId) return;
  try {
    for (const id of await clearKeyLimited(presetId)) {
      await publish(projectId, { type: "agent.limited", presetId: id, until: null, note: null });
    }
  } catch (e) {
    console.error("[formic] could not lift an agent's usage mark:", e);
  }
}
