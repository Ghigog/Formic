import { applyCardAction } from "@/lib/agents/card-actions";
import { columnChatAgentFor } from "@/lib/agents/presets";
import { addEpicNote } from "@/lib/agents/epic-notes";
import { addNote } from "@/lib/coder/notes";
import { repository } from "@/lib/db";
import type { BoardCard } from "@/lib/domain/entities";
import { isUsageLimitStop } from "@/lib/domain/notice";

export const RESUME_MESSAGE = "Your token limit has been restored. Please resume your work.";

/** The cards a usage limit stopped, and nothing has picked up since. */
export async function limitStoppedCards(projectId: string): Promise<BoardCard[]> {
  return (await repository().boardCards(projectId)).filter(
    (card) => isUsageLimitStop(card) && !!card.stalledIn,
  );
}

/**
 * Rings the bell: starts the work again on every card stopped by a usage
 * limit, in the column it stopped in, the way the drawer's redo does. A card
 * whose column agent is still limited is skipped; the person can ring again
 * later. The resume message goes on the card as a note, so the agent reads it
 * and the person can see the bell reached the card.
 */
export async function ringBell(
  projectId: string,
  /** At most this many restarted; the rest are left for a later ring. */
  max = Infinity,
): Promise<{ sent: number; skipped: number; left: number }> {
  let sent = 0;
  let skipped = 0;
  const cards = await limitStoppedCards(projectId);
  let seen = 0;
  for (const card of cards) {
    if (sent >= max) break;
    seen++;
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
  return { sent, skipped, left: cards.length - seen };
}

/**
 * Cards paused by a usage mark that has since been lifted (clearKeyLimited):
 * the account was seen working, so the mark was wrong and the pause with it.
 * They start again on their own, once each, without waiting for the bell.
 * A mark that simply ran out keeps its time and is left to the bell.
 */
export async function resumeLifted(projectId: string): Promise<number> {
  const repo = repository();
  const agents = await repo.columnAgents(projectId);
  let resumed = 0;
  for (const card of await limitStoppedCards(projectId)) {
    const presetId = agents[card.stalledIn as keyof typeof agents];
    const preset = presetId ? (await repo.presetForRun(presetId))?.preset : null;
    if (!preset || preset.limitedUntil) continue;
    const agent = await columnChatAgentFor(projectId, card.stalledIn!);
    if (agent.kind === "limited" || agent.kind === "none") continue;
    if (!(await repo.claimDelivery(`lifted:${card.id}:${card.updatedAt}`))) continue;
    await applyCardAction(projectId, card.kind, card.id, { type: "redo", instruction: RESUME_MESSAGE });
    resumed++;
  }
  return resumed;
}
