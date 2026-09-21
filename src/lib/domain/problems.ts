import type { DagProblem } from "./dag";

/**
 * Validation problems rendered as prose. These strings go two places: the UI,
 * and back into the Architect Agent's next attempt as the correction message.
 * They have to be readable by both, which means naming the ticket keys and the
 * exact paths rather than saying "invalid graph".
 */
export function describeProblem(problem: DagProblem): string {
  switch (problem.kind) {
    case "duplicate":
      return `Two tickets share the key "${problem.key}". Every ticket key must be unique.`;
    case "self":
      return `Ticket "${problem.key}" lists itself as a dependency.`;
    case "dangling":
      return `Ticket "${problem.from}" depends on "${problem.to}", which is not one of the tickets you returned.`;
    case "cycle":
      return `These tickets depend on each other in a loop: ${problem.cycle.join(" -> ")}. Dependencies must form a DAG.`;
    case "scope_overlap": {
      const pairs = problem.paths
        .map(([a, b]) => (a === b ? `"${a}"` : `"${a}" and "${b}"`))
        .join(", ");
      return `Tickets "${problem.a}" and "${problem.b}" can run at the same time but their file scopes overlap (${pairs}). Give them disjoint directories, or make one depend on the other.`;
    }
  }
}

export function describeProblems(problems: readonly DagProblem[]): string {
  return problems.map((p, i) => `${i + 1}. ${describeProblem(p)}`).join("\n");
}
