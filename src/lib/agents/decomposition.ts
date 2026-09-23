import { z } from "zod";
import { fileScopeSchema } from "@/lib/domain/entities";
import { validateDag } from "@/lib/domain/dag";
import { describeProblems } from "@/lib/domain/problems";
import { normalizeScope } from "@/lib/domain/scope";
import type { DraftTicket } from "./ports";

/**
 * What the Architect Agent must return, and the check it must pass, whichever
 * provider it runs on. The model is not trusted to get the graph right: a
 * failure goes back to it as a correction rather than onto the board.
 */

export const draftTicketSchema = z.object({
  key: z.string().describe('Short stable key, e.g. "T-1".'),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()).min(1),
  fileScope: fileScopeSchema,
  size: z.enum(["S", "M", "L", "XL"]),
  dependsOn: z.array(z.string()),
});

export const decompositionSchema = z.object({
  tickets: z.array(draftTicketSchema).min(2).max(12),
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

  const tickets = parsed.data.tickets.map((t) => ({
    ...t,
    fileScope: normalizeScope(t.fileScope),
  }));
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
