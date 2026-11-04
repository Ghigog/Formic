import "server-only";

import { assistantAgentFor } from "@/lib/agents/presets";
import { repository } from "@/lib/db";
import { askedIn, askerOf, firstQuestion, isQuestion } from "@/lib/domain/question";

/**
 * The PM and the agents' questions. It does not check every plan and change: the agents are
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
export function questionPrompt(card: { key: string; title: string }, reason: string): string {
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
export async function wakePm(projectId: string, cardId: string, reason: string): Promise<void> {
  const asker = askerOf(reason);
  if (asker && FOR_THE_PERSON.has(asker)) return;
  const agent = await assistantAgentFor(projectId);
  if (agent.kind === "none" || agent.kind === "limited") return;
  const repo = repository();
  const card = await repo.cardById(cardId);
  if (!card) return;
  const pending = await repo.addAssistantMessage({ projectId, role: "assistant", content: "", status: "pending" });
  const { answer } = await import("@/lib/assistant/turn");
  await answer(projectId, pending.id, questionPrompt({ key: card.key, title: card.title }, reason));
}

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"];
const NUMBERS = ["Zero", "One", "Two", "Three", "Four", "Five"];

/**
 * What the PM says to open a call: the cards waiting on the person, read one
 * at a time with its suggestion, or a one-line greeting when none are.
 */
export function openerPrompt(waiting: ReadonlyArray<{ key: string; title: string; blockedReason: string | null }>): string {
  const cards = waiting.filter((c) => isQuestion(c.blockedReason));
  if (cards.length === 0) {
    return "[From Formic, not the person] The person just called you by voice. Greet them in one short line and ask what they need. Do not call any tools.";
  }
  const count = cards.length <= 5 ? NUMBERS[cards.length]! : String(cards.length);
  const list = cards.slice(0, ORDINALS.length).map((c, i) => {
    const asker = askerOf(c.blockedReason!) ?? "An agent";
    return `${ORDINALS[i]}: ${asker} on ${c.key} (${c.title}) asks: ${firstQuestion(c.blockedReason!)}`;
  });
  return [
    "[From Formic, not the person] The person just called you by voice. These cards are waiting on their answer, questions you could not settle from what they already asked for:",
    "",
    ...list,
    "",
    `Open by saying how many are waiting ("${count} ${cards.length === 1 ? "question is" : "questions are"} waiting."), then read only the first one aloud in a sentence or two, with your suggested answer, and ask what they want to answer. Speak plainly: no lists, no markdown. Read the next one only after they answer.`,
  ].join("\n");
}
