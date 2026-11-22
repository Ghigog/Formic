import type { Prd } from "./entities";

/**
 * The plan of an Epic that arrived already broken down (the PM made it with
 * its tickets): read off those tickets, so no Product Agent has to write one
 * and no Architect Agent breaks it down again.
 */
export function prdFromTickets(
  summary: string,
  tickets: ReadonlyArray<{ key: string; title: string; description: string; acceptanceCriteria: string[] }>,
): Prd {
  const criteria = tickets.flatMap((t) => t.acceptanceCriteria).filter((c) => c.trim());
  return {
    summary,
    problem: summary,
    scope: tickets.map((t) => `${t.key}: ${t.title}`),
    outOfScope: [],
    technicalContext: [],
    userStories: tickets.map((t) => (t.description.split("\n")[0] ?? "").replace(/^\*\*User story:\*\* /, "") || t.title),
    // A plan needs at least one: tickets with none are done when each is.
    successCriteria: criteria.length ? criteria : tickets.map((t) => `${t.key} is done: ${t.title}`),
  };
}
