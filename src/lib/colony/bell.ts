import { ask, ChatBusyError } from "@/lib/agents/card-chat";
import { columnChatAgentFor } from "@/lib/agents/presets";
import { repository } from "@/lib/db";
import { classifyNotice } from "@/lib/domain/notice";

/** The failure type runner.ts gives a card whose agent ran out of usage. */
const USAGE_LIMIT = "Usage limit reached";
export const RESUME_MESSAGE = "Your token limit has been restored. Please resume your work.";

/**
 * Rings the bell: tells every card stopped by a usage limit to resume. A card
 * whose column agent is still limited, or still answering its last message,
 * is skipped; the person can ring again later.
 */
export async function ringBell(projectId: string): Promise<{ sent: number; skipped: number }> {
  const cards = await repository().boardCards(projectId);
  let sent = 0;
  let skipped = 0;
  for (const card of cards) {
    if (classifyNotice(card)?.shortDescription !== USAGE_LIMIT || !card.stalledIn) continue;
    const agent = await columnChatAgentFor(projectId, card.stalledIn);
    if (agent.kind === "limited" || agent.kind === "none") {
      skipped++;
      continue;
    }
    try {
      await ask(projectId, card.kind, card.id, RESUME_MESSAGE);
      sent++;
    } catch (e) {
      if (!(e instanceof ChatBusyError)) throw e;
      skipped++;
    }
  }
  return { sent, skipped };
}
