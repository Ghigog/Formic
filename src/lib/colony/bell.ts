import { applyCardAction } from "@/lib/agents/card-actions";
import { columnChatAgentFor } from "@/lib/agents/presets";
import { addEpicNote } from "@/lib/agents/epic-notes";
import { addNote } from "@/lib/coder/notes";
import { repository } from "@/lib/db";
import type { BoardCard } from "@/lib/domain/entities";
import { classifyNotice } from "@/lib/domain/notice";

/** The failure type runner.ts gives a card whose agent ran out of usage. */
const USAGE_LIMIT = "Usage limit reached";
export const RESUME_MESSAGE = "Your token limit has been restored. Please resume your work.";

/** The cards a usage limit stopped, and nothing has picked up since. */
export async function limitStoppedCards(projectId: string): Promise<BoardCard[]> {
  return (await repository().boardCards(projectId)).filter(
    (card) => classifyNotice(card)?.shortDescription === USAGE_LIMIT && !!card.stalledIn,
  );
}

/**
 * Rings the bell: starts the work again on every card stopped by a usage
 * limit, in the column it stopped in, the way the drawer's redo does. A card
 * whose column agent is still limited is skipped; the person can ring again
 * later. The resume message goes on the card as a note, so the agent reads it
 * and the person can see the bell reached the card.
 */
export async function ringBell(projectId: string): Promise<{ sent: number; skipped: number }> {
  let sent = 0;
  let skipped = 0;
  for (const card of await limitStoppedCards(projectId)) {
    const agent = await columnChatAgentFor(projectId, card.stalledIn!);
    if (agent.kind === "limited" || agent.kind === "none") {
      skipped++;
      continue;
    }
    if (card.kind === "ticket") await addNote(projectId, card.id, RESUME_MESSAGE);
    else await addEpicNote(projectId, card.id, RESUME_MESSAGE);
    await applyCardAction(projectId, card.kind, card.id, { type: "redo", instruction: RESUME_MESSAGE });
    sent++;
  }
  return { sent, skipped };
}
