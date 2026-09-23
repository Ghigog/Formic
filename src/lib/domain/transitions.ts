import { z } from "zod";
import { COLUMNS } from "./status";
import { CARD_KINDS } from "./entities";

/**
 * The single user-facing trigger in the product. A drag handler emits one of
 * these and nothing else; agent work is started by the server in response.
 *
 * Keeping this an explicit contract rather than a function call is what lets
 * the board be built and demoed against mock agents (see agents/mock.ts)
 * before a single real pipeline exists.
 */
export const cardTransitionSchema = z.object({
  cardId: z.string().min(1),
  kind: z.enum(CARD_KINDS),
  from: z.enum(COLUMNS),
  to: z.enum(COLUMNS),
  /** Fractional index within the destination column. */
  position: z.number(),
  /** Tickets: dropped outside their epic's group, so they stand alone. */
  detached: z.boolean().optional(),
  /** Who moved it. Agents set this to their role name. */
  actor: z.enum(["user", "agent", "system"]).default("user"),
});

export type CardTransition = z.infer<typeof cardTransitionSchema>;

export const transitionResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** The status the card actually landed in. */
    status: z.string(),
    /** Set when the move started an agent run. */
    runId: z.string().nullable().default(null),
    /**
     * The card landed where it was dropped, but cannot work there: what is
     * wrong and how to fix it. It stays on the card until it moves again.
     */
    problem: z.string().nullable().optional(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string(),
    /** Where the board should put the card back. */
    revertTo: z.enum(COLUMNS),
  }),
]);

export type TransitionResult = z.infer<typeof transitionResultSchema>;
