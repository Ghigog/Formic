/**
 * The labels Formic writes onto GitHub issues, and reads back.
 *
 * Its own module, with no `server-only` and no I/O, because three very
 * different places need the same names: the mirror that writes them
 * (`sync.ts`), the intake that reads the opt-in (`intake.ts`), and the webhook
 * that decides whether an issue delivery is worth a signal
 * (`src/lib/review/webhook.ts`, which is deliberately free of I/O).
 */

/** What every label Formic writes starts with. */
export const LABEL_PREFIX = "formic: ";

/** Formic stopped this and is waiting for a person. */
export const BLOCKED_LABEL = `${LABEL_PREFIX}needs a human`;

/**
 * The opt-in: a person puts this on an issue to have Formic take it over as a
 * ticket. Nothing is imported without it — importing every open issue would
 * turn any repository into hundreds of cards on the first sweep.
 */
export const INTAKE_LABEL = `${LABEL_PREFIX}intake`;

/**
 * A label Formic itself wrote for a card: the column it is in, or that it
 * needs a person. An issue carrying one is a mirror of something already on a
 * board, never a request to import — which is what stops Formic filing issues
 * about its own issues.
 */
export function isCardLabel(label: string): boolean {
  return label.startsWith(LABEL_PREFIX) && label !== INTAKE_LABEL;
}
