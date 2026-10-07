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
 * The ticket template every agent writes to: a user story, requirements (the
 * how, when the approach is not already obvious), and acceptance criteria in
 * Gherkin. The story carries the what and the why, so there is no separate
 * context or description field. A schema rather than a suggestion in a
 * prompt, so every provider fills in every required part.
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
  requirements: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "How: technical requirements, constraints and the approach to take. Leave empty when the acceptance criteria already make the approach obvious.",
    ),
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
  storyPoints: z
    .literal(STORY_POINTS)
    .describe(
      "The estimate in story points, on the Fibonacci scale: 1, 2, 3, 5, 8 or 13. Size the work rather than the change: the code a ticket must read before it can be written counts, so a ticket that has to learn the codebase first is not a 2.",
    ),
  dependsOn: z.array(z.string()),
  needsHuman: z
    .string()
    .optional()
    .describe(
      "Only for a ticket no coding agent can do, such as setting up an account, a manual test on production, or a decision: why it needs a person. Leave it out for every ticket an agent can do in the repository.",
    ),
});

export type TicketSpec = z.infer<typeof ticketSpecSchema>;

/** One Gherkin scenario on one line, as tickets store acceptance criteria. */
export function gherkin(c: { given: string; when: string; then: string }): string {
  const clause = (s: string) => s.trim().replace(/^(given|when|then)\s+/i, "").replace(/[.\s]+$/, "");
  return `Given ${clause(c.given)}, when ${clause(c.when)}, then ${clause(c.then)}.`;
}

/**
 * A ticket as the board stores it: the user story, then the requirements
 * under a heading when there are any. It reads well in the GitHub issue, the
 * pull request and the coding agent's brief alike.
 */
export function toDraftTicket(spec: TicketSpec): DraftTicket {
  const { as, want, soThat } = spec.userStory;
  const description = [
    `**User story:** As ${/^(a|an|the)\s/i.test(as.trim()) ? as.trim() : `a ${as.trim()}`}, I'd like to ${want.trim()}, so that ${soThat.trim().replace(/\.$/, "")}.`,
    ...(spec.requirements.length
      ? ["", "### Requirements", ...spec.requirements.map((r) => `- ${r.trim()}`)]
      : []),
  ].join("\n");
  return {
    key: spec.key,
    title: spec.title,
    description,
    acceptanceCriteria: spec.acceptanceCriteria.map(gherkin),
    fileScope: normalizeScope(spec.fileScope),
    storyPoints: spec.storyPoints,
    dependsOn: spec.dependsOn,
    ...(spec.needsHuman?.trim() ? { needsHuman: spec.needsHuman.trim() } : {}),
  };
}

/**
 * A raw request that turns out to need a PRD and a breakdown rather than one
 * ticket. The Architect Agent answers this instead of a ticket, and the card
 * goes back to the Backlog for the Product Agent to scope properly. The
 * pipeline path that handles it is the same one the Product Agent's reroute
 * uses, so the two agree on the shape.
 */
export const ticketRerouteAnswer = z.object({
  kind: z.literal("reroute"),
  reason: z.string().min(1).describe("Why this needs a PRD and a breakdown, not one ticket."),
});

/**
 * What a draft from a raw request must be: the one ticket asked for, or a
 * reroute. The reroute comes first because a ticket spec has no `kind` field,
 * so nothing that is a ticket can match it, and nothing that is a reroute can
 * satisfy the ticket's required fields.
 */
export const ticketOrRerouteSchema = z.union([ticketRerouteAnswer, ticketSpecSchema]);

export const decompositionSchema = z.object({
  tickets: z.array(ticketSpecSchema).min(1).max(12),
});

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
