import { z } from "zod";
import { STORY_POINTS, fileScopeSchema } from "@/lib/domain/entities";
import { validateDag } from "@/lib/domain/dag";
import { describeProblems } from "@/lib/domain/problems";
import { normalizeScope } from "@/lib/domain/scope";
import type { DraftTicket } from "./ports";

/**
 * What the Architect Agent must return, and the check it must pass, whichever
 * provider it runs on. The model is not trusted to get the graph right: a
 * failure goes back to it as a correction rather than onto the board.
 */

/**
 * The ticket template every agent writes to: a user story, the why, the
 * what, the how, and acceptance criteria in Gherkin. A schema rather than a
 * suggestion in a prompt, so every provider fills in every part.
 */
export const ticketSpecSchema = z.object({
  key: z.string().describe('Short stable key, e.g. "T-1".'),
  title: z.string(),
  userStory: z
    .object({
      as: z.string().min(1).describe('Who wants this, e.g. "a board owner".'),
      want: z.string().min(1).describe('What they would like to do, e.g. "export my board as CSV".'),
      soThat: z.string().min(1).describe('Why it matters to them, e.g. "I can report on it elsewhere".'),
    })
    .describe("As a <as>, I'd like to <want>, so that <soThat>."),
  context: z.string().min(1).describe("Why: the problem or motivation behind the change."),
  description: z.string().min(1).describe("What: the change itself, in the domain's own words."),
  requirements: z
    .array(z.string().min(1))
    .min(1)
    .describe("How: technical requirements, constraints and the approach to take."),
  acceptanceCriteria: z
    .array(
      z.object({
        given: z.string().min(1),
        when: z.string().min(1),
        then: z.string().min(1),
      }),
    )
    .min(1)
    .describe("Gherkin scenarios: Given <context>, When <action>, Then <outcome>."),
  fileScope: fileScopeSchema,
  size: z.enum(["S", "M", "L", "XL"]),
  storyPoints: z
    .literal(STORY_POINTS)
    .describe("The estimate in story points, on the Fibonacci scale: 1, 2, 3, 5, 8 or 13."),
  dependsOn: z.array(z.string()),
});

export type TicketSpec = z.infer<typeof ticketSpecSchema>;

/** One Gherkin scenario on one line, as tickets store acceptance criteria. */
export function gherkin(c: { given: string; when: string; then: string }): string {
  const clause = (s: string) => s.trim().replace(/^(given|when|then)\s+/i, "").replace(/[.\s]+$/, "");
  return `Given ${clause(c.given)}, when ${clause(c.when)}, then ${clause(c.then)}.`;
}

/**
 * A ticket as the board stores it: the template's parts become a Markdown
 * description with a heading each, which reads well in the GitHub issue,
 * the pull request and the coding agent's brief alike.
 */
export function toDraftTicket(spec: TicketSpec): DraftTicket {
  const { as, want, soThat } = spec.userStory;
  const description = [
    `**User story:** As ${/^(a|an|the)\s/i.test(as.trim()) ? as.trim() : `a ${as.trim()}`}, I'd like to ${want.trim()}, so that ${soThat.trim().replace(/\.$/, "")}.`,
    "",
    "### Context",
    spec.context.trim(),
    "",
    "### Description",
    spec.description.trim(),
    "",
    "### Requirements",
    ...spec.requirements.map((r) => `- ${r.trim()}`),
  ].join("\n");
  return {
    key: spec.key,
    title: spec.title,
    description,
    acceptanceCriteria: spec.acceptanceCriteria.map(gherkin),
    fileScope: normalizeScope(spec.fileScope),
    size: spec.size,
    storyPoints: spec.storyPoints,
    dependsOn: spec.dependsOn,
  };
}

export const decompositionSchema = z.object({
  tickets: z.array(ticketSpecSchema).min(1).max(12),
});

/** Attempts before the Architect Agent gives up and asks for a human. */
export const MAX_DECOMPOSITION_ATTEMPTS = 3;

export function checkDecomposition(
  raw: unknown,
): { ok: true; tickets: DraftTicket[] } | { ok: false; correction: string } {
  const parsed = decompositionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      correction: `That response could not be read as the required shape: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}\n\nReturn the same decomposition in the required format.`,
    };
  }

  const tickets = parsed.data.tickets.map(toDraftTicket);
  const validation = validateDag(
    tickets.map((t) => ({ key: t.key, dependsOn: t.dependsOn, fileScope: t.fileScope })),
  );
  if (validation.ok) return { ok: true, tickets };

  return {
    ok: false,
    correction: [
      "That decomposition is not safe to run. Problems:",
      "",
      describeProblems(validation.problems),
      "",
      "Return a corrected decomposition in the same format.",
    ].join("\n"),
  };
}
