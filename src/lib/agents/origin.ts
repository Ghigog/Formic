/**
 * The person's request, in their own words, for the agents after the PRD.
 * Each handoff (request, PRD, tickets, code, review) used to see only the step
 * before it, so what the person asked for faded a little at every one. The
 * Architect, the Coder and the Reviewer now read it too; see
 * docs/plans/craft-and-direction.md.
 *
 * No server imports: the runner builds prompts from it too.
 */

/** Enough for any request a person types; an attachment-sized paste is cut. */
const MAX_REQUEST = 6_000;

export interface Origin {
  /** The Epic's title. */
  epic: string;
  /** What the person wrote, unedited. */
  request: string;
  /** The PRD's summary, when there is one. */
  summary?: string | null;
}

/** The origin as prompt lines: the person's words quoted, then the PRD's summary. */
export function originLines(origin: Origin): string[] {
  const request = origin.request.trim();
  const words = request.length > MAX_REQUEST ? `${request.slice(0, MAX_REQUEST)}…` : request;
  return [
    `This work is part of the Epic "${origin.epic}". The person's request, in their own words. Every explicit choice in it (a gesture, a name, a number, a behaviour) is a requirement, and where the ticket below disagrees with it, the person's words win:`,
    ...words.split("\n").map((line) => `> ${line}`),
    ...(origin.summary?.trim() ? ["", `The PRD's summary: ${origin.summary.trim()}`] : []),
  ];
}
