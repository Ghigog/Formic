import { z } from "zod";

/**
 * A question an agent asks the person, and waits on. A card with one is
 * stalled like any other, and its reason says it is a question, so the board
 * gives it its own notice (neither a failure nor an alert) and the card's chat
 * takes the person's next message as the answer and picks the work back up.
 * See docs/plans/craft-and-direction.md.
 *
 * No server imports: the board renders questions and the agents ask them.
 */

/** The most an agent may ask at once. More reads as an interrogation, not an interview. */
export const MAX_QUESTIONS = 3;

export const agentQuestionSchema = z.object({
  question: z.string().min(1).describe("The question, in plain words the person can answer in a sentence."),
  why: z.string().describe("Why the answer changes what gets built, in one short line."),
});
export type AgentQuestion = z.infer<typeof agentQuestionSchema>;

/** The Product Agent's questions, beside its PRD. Capped in code, not the schema. */
export const productQuestions = z
  .array(agentQuestionSchema)
  .describe(
    `Questions for the person, at most ${MAX_QUESTIONS}. Empty unless an answer would change what gets built and you cannot tell what they would want. With any here, the PRD is your draft and the Epic waits for their answer.`,
  );

/** The first line of a question's reason. The rest of the reason is the detail. */
const QUESTION_LINE = "Question: ";

/** The stalled card's reason for one agent's questions. */
export function questionReason(asker: string, questions: readonly AgentQuestion[]): string {
  const asked = questions.slice(0, MAX_QUESTIONS).filter((q) => q.question.trim());
  if (asked.length === 0) throw new Error("A question needs a question.");
  const [first] = asked;
  return [
    `${QUESTION_LINE}${first!.question.trim()}`,
    `${asker} is waiting for your answer. Reply in this card's chat and the work carries on with it.`,
    "",
    ...asked.map((q, i) => `${asked.length > 1 ? `${i + 1}. ` : ""}${q.question.trim()}${q.why.trim() ? `\n   Why: ${q.why.trim()}` : ""}`),
  ].join("\n");
}

/** Whether a stalled card's reason is a question waiting for the person. */
export function isQuestion(reason: string | null | undefined): boolean {
  return !!reason?.startsWith(QUESTION_LINE);
}

/** The questions a reason asks, as written, for briefing the agent with the answer. */
export function askedIn(reason: string): string {
  const lines = reason.split("\n");
  const list = lines.slice(3).join("\n").trim();
  return list || lines[0]!.slice(QUESTION_LINE.length).trim();
}

/** The note an answer becomes, so the agent that asked reads both together. */
export function answerNote(reason: string, answer: string): string {
  return `You asked the person:\n${askedIn(reason)}\n\nThey answered: ${answer.trim()}`;
}
