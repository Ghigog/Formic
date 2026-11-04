import "server-only";

import { assistantAgentFor } from "@/lib/agents/presets";
import { repository } from "@/lib/db";
import { askedIn, askerOf } from "@/lib/domain/question";

/**
 * The PM, on call. It does not check every plan and change: the agents are
 * trusted to ask when they are unsure, and every question one asks wakes the
 * PM first. When what the person already asked for settles it (their words,
 * the PRD, an audit's checks, the design document), the PM answers and the
 * work carries on. When only the person can settle it, the PM puts it to them
 * in its chat with a suggestion. The person can still answer in the card's
 * chat at any time; whoever answers first wins.
 *
 * It runs on whichever agent the board's PM chat uses: an API agent answers
 * in seconds, a CLI agent in a GitHub Actions job, which is fine for
 * something this rare. See docs/plans/craft-and-direction.md.
 */

export const PM = "The PM";

/** Askers whose questions are for the person alone, never for the PM to settle. */
const FOR_THE_PERSON = new Set([PM, "The Designer"]);

/** What wakes the PM: the card, who asked, and what. */
export function onCallPrompt(card: { key: string; title: string }, reason: string): string {
  const asker = askerOf(reason) ?? "An agent";
  return [
    `[From Formic, not the person] ${asker} on ${card.key} (${card.title}) asked a question, and the card is waiting for an answer:`,
    "",
    askedIn(reason),
    "",
    `Read ${card.key}'s state, its Epic and what the person asked for. If their own words, the PRD, an audit's checks or the design document settle it, answer it now with answer_question (own: true) and tell the person in a line what you answered and why. If only the person can settle it, do not answer: put the question to them in plain words, with your suggested answer and why, and say they can reply here or in the card's chat.`,
  ].join("\n");
}

/**
 * A card has started waiting on a question: wake the PM for it. Does nothing
 * when the board has no PM agent it can use, so the question simply waits
 * for the person, as before.
 */
export async function callPm(projectId: string, cardId: string, reason: string): Promise<void> {
  const asker = askerOf(reason);
  if (asker && FOR_THE_PERSON.has(asker)) return;
  const agent = await assistantAgentFor(projectId);
  if (agent.kind === "none" || agent.kind === "limited") return;
  const repo = repository();
  const card = await repo.cardById(cardId);
  if (!card) return;
  const pending = await repo.addAssistantMessage({ projectId, role: "assistant", content: "", status: "pending" });
  const { answer } = await import("@/lib/assistant/turn");
  await answer(projectId, pending.id, onCallPrompt({ key: card.key, title: card.title }, reason));
}
