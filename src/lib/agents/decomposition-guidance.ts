import type { ExistingTicket } from "./ports";

/**
 * What to tell the Architect Agent when it is decomposing an Epic it has
 * already broken down once, rather than for the first time: the person's
 * instructions, which tickets it cannot touch because they are in flight,
 * and which ones are free to change. Empty with no instructions, so a first
 * decomposition's prompt is unchanged.
 */
export function decompositionGuidance(existing: ExistingTicket[] | undefined, instructions: string[] | undefined): string {
  if (!instructions?.length) return "";
  const inFlight = (existing ?? []).filter((t) => t.inFlight);
  const free = (existing ?? []).filter((t) => !t.inFlight);

  return [
    "",
    "This Epic has already been broken down once. The person has since asked for this, oldest first:",
    ...instructions.map((i) => `- ${i}`),
    "",
    inFlight.length > 0
      ? [
          "These tickets already have an agent's work on them and cannot be replaced or renamed; only add dependencies on them if the instructions need it:",
          ...inFlight.map((t) => `- ${t.key}: ${t.title}`),
        ].join("\n")
      : "No ticket has started work yet, so any of them may change.",
    "",
    free.length > 0
      ? [
          "Tickets not yet started, as they stand now:",
          ...free.map(
            (t) =>
              `- ${t.key}: ${t.title}${t.storyPoints ? ` (${t.storyPoints} pts)` : ""}\n  ${t.description}`,
          ),
        ].join("\n")
      : "There are no unstarted tickets yet; the instructions above describe new ones.",
    "",
    "Apply the smallest change that satisfies the instructions. Where they do not ask for a change, keep a ticket's key, title, description and scope exactly as they already are rather than rewriting it. Output the complete set of tickets that should exist for the work not yet started; the ones already in flight are kept automatically and should not be repeated.",
  ].join("\n");
}
