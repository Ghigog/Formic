import "server-only";

import { assistantAgentFor } from "@/lib/agents/presets";
import { postPmMessage } from "@/lib/assistant/pm-messages";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { vcs } from "@/lib/vcs";
import { admitWake, type WakeVerdict } from "./wake-gate";
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

/** The head of the card's branch, or "" when it has none or it cannot be read. */
async function headOf(projectId: string, branch: string | null): Promise<string> {
  if (!branch) return "";
  try {
    const project = await projectFor(projectId);
    if (!project.repoFullName) return "";
    const creds = await credentialsForProject(project);
    return (await vcs(project.repoFullName, creds.repoToken).branchHead(branch)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Whether the PM may wake for this card now (./wake-gate.ts). A wake-up it
 * may not take is said once in the chat, and the card waits for the person.
 */
async function admit(projectId: string, card: { id: string; key: string }, kind: "question" | "stall", now: Date): Promise<WakeVerdict> {
  const detail = await repository().ticketDetail(card.id);
  const head = await headOf(projectId, detail?.branchName ?? null);
  return admitWake({ projectId, cardId: card.id, cardKey: card.key, head, kind, now });
}

/** The PM's turn on `prompt`, in a reply of its own. An API PM answers in-process, which can take minutes. */
async function startWake(projectId: string, prompt: string): Promise<void> {
  const pending = await repository().addAssistantMessage({ projectId, role: "assistant", content: "", status: "pending" });
  const { answer } = await import("@/lib/assistant/turn");
  await answer(projectId, pending.id, prompt);
}

/**
 * A card has started waiting on a question: wake the PM for it. Does nothing
 * when the board has no PM agent it can use, or the PM is at a wake-up
 * limit, so the question simply waits for the person, as before.
 */
export async function wakePm(projectId: string, cardId: string, reason: string, now = new Date()): Promise<void> {
  const asker = askerOf(reason);
  if (asker && FOR_THE_PERSON.has(asker)) return;
  const agent = await assistantAgentFor(projectId);
  if (agent.kind === "none" || agent.kind === "limited") return;
  const repo = repository();
  const card = await repo.cardById(cardId);
  if (!card) return;
  const verdict = await admit(projectId, card, "question", now);
  if (!verdict.ok) {
    if (verdict.say) await postPmMessage(projectId, { content: verdict.say, cards: [{ id: card.id, key: card.key, title: card.title }] });
    return;
  }
  await startWake(projectId, questionPrompt({ key: card.key, title: card.title }, reason));
}

/**
 * What wakes the PM when a card stops for a reason that is not a question. A
 * PM that can change code (a Claude Code session) fixes what it can on the
 * ticket's branch; any other PM explains and proposes.
 */
export function stallPrompt(card: { key: string; title: string }, reason: string, canFix = false): string {
  const act = canFix
    ? `If you can see the fix, make it: check out ${card.key}'s branch, change what is needed, run the checks that failed, and commit on that branch (Formic pushes it when no agent is working there). Then rerun_checks and tell the person in one line what was wrong and what you did. If you cannot fix it, or the fix needs the person's decision, tell them in a few plain sentences what is failing, why you think so, and your suggested next step.`
    : `Then tell the person in a few plain sentences: what the agents tried, what is actually failing and why you think so, and your suggested next step. Where the fix is a board action (rerun_ci, move_card), offer it with propose.`;
  return [
    `[From Formic, not the person] ${card.key} (${card.title}) has stopped and needs a person. Formic recorded this reason:`,
    "",
    reason,
    "",
    `Do not just repeat it. Call card_status on ${card.key}, read its runs and the log of the check that failed. ${act}`,
  ].join("\n");
}

/**
 * A card stopped for a reason other than a question or a usage limit: wake
 * the PM to look into it. Returns whether it woke; when it did not (no PM
 * agent it can use, or a wake-up limit), the caller tells the person, with
 * `say`, the limit's line when it is new.
 */
export async function wakePmForStall(
  projectId: string,
  cardId: string,
  reason: string,
  now = new Date(),
): Promise<{ woke: boolean; say: string | null }> {
  const agent = await assistantAgentFor(projectId);
  if (agent.kind === "none" || agent.kind === "limited") return { woke: false, say: null };
  const repo = repository();
  const card = await repo.cardById(cardId);
  if (!card) return { woke: false, say: null };
  const verdict = await admit(projectId, card, "stall", now);
  if (!verdict.ok) return { woke: false, say: verdict.say };
  // Decided now; the turn itself runs on, so the caller is not held for minutes.
  void startWake(projectId, stallPrompt({ key: card.key, title: card.title }, reason, agent.kind === "cli" && agent.agent.info.cli === "claude")).catch(
    (e) => console.error("[formic] PM look into a stalled card failed:", e),
  );
  return { woke: true, say: null };
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
