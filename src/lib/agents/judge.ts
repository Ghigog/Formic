import { z } from "zod";
import type { CoderTask } from "./ports";

/**
 * What the Reviewer Agent is asked when a ticket's scouts come back: which
 * change to keep. Shared by every provider's answer to it.
 */

/** One scout's change, as the Reviewer sees it. */
export interface ScoutCandidate {
  id: string;
  /** "S1", "S2", ... */
  label: string;
  /** The approach it was told to take. */
  approach: string;
  summary: string;
  files: string[];
  /** The change as a unified diff, cut short when it is long. */
  diff: string;
}

export interface ScoutVerdict {
  /** The label of the change to keep. */
  pick: string;
  /** Why, in a sentence or two, for the person. */
  why: string;
  /** What the other changes found that later agents should know, if anything. */
  lessons: string[];
}

export const scoutVerdictSchema = z.object({
  pick: z.string().describe("The label of the change to keep, e.g. S2."),
  why: z.string().describe("Why it is the best of them, in one or two sentences a person reads on the ticket."),
  lessons: z
    .array(z.string())
    .max(3)
    .describe(
      "What the changes not kept found that agents on other tickets should know: a trap, a convention, a better place for something. Empty when there is nothing.",
    ),
});

export const JUDGE_BRIEF = `You are the Reviewer Agent. Several agents (scouts) each wrote a change for the same ticket, each told to take a different approach. Pick the one change to keep.

Judge each against the ticket's acceptance criteria first: a change that misses one loses to one that meets them all. Then prefer the change that is correct in the cases the ticket implies, fits the code around it, and is simplest to maintain. Size only breaks ties: a small change that is wrong is not better.

Say why in plain words the person can check. Then note anything the other changes found that agents on other tickets should know; leave it empty when there is nothing worth knowing.`;

/** The longest a scout's diff runs in the prompt. */
export const MAX_DIFF_CHARS = 24_000;

export function judgePrompt(task: CoderTask, candidates: ScoutCandidate[]): string {
  return [
    `Ticket ${task.key}: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
    ...candidates.flatMap((c) => [
      "",
      `=== ${c.label} ===`,
      `Approach it was told to take: ${c.approach}`,
      `What it says it did: ${c.summary}`,
      `Files: ${c.files.join(", ") || "(none listed)"}`,
      "",
      c.diff || "(no diff available)",
    ]),
  ].join("\n");
}

/** A verdict held to the candidates: an unknown pick is no verdict. */
export function acceptVerdict(raw: unknown, candidates: ScoutCandidate[]): ScoutVerdict | string {
  const parsed = scoutVerdictSchema.safeParse(raw);
  if (!parsed.success) return `That answer does not match the schema: ${parsed.error.issues[0]?.message}.`;
  const pick = parsed.data.pick.trim().toUpperCase();
  if (!candidates.some((c) => c.label === pick)) {
    return `Pick one of ${candidates.map((c) => c.label).join(", ")}.`;
  }
  return { pick, why: parsed.data.why.trim(), lessons: parsed.data.lessons.map((l) => l.trim()).filter(Boolean) };
}
