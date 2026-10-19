/**
 * escalateStoryPoints: what happens to a ticket's story points when its run
 * exceeds the token budget for them. Pure; the controller applies the result.
 */

const STORY_POINTS = [1, 2, 3, 5, 8, 13];

export type Escalation =
  | { kind: "none" }
  | { kind: "escalate"; from: number; to: number }
  | { kind: "repointed-twice"; storyPoints: number };

export function escalateStoryPoints(input: {
  storyPoints: number | null;
  enabled: boolean;
  /** When the ticket was escalated before; null if never. */
  escalatedAt: string | null;
}): Escalation {
  if (!input.enabled) return { kind: "none" };
  const from = input.storyPoints ?? 1;
  if (input.escalatedAt) return { kind: "repointed-twice", storyPoints: from };
  const to = STORY_POINTS.find((p) => p > from);
  return to == null ? { kind: "none" } : { kind: "escalate", from, to };
}
