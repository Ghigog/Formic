import type { ExtrasMap } from "@/components/board/card";
import type { BoardCard } from "@/lib/domain/entities";
import type { CheckSummary, VcsClient } from "@/lib/vcs/types";

/** Skipped and neutral checks block nothing; cancelled and stale ones are no result. */
const GREEN = ["success", "neutral", "skipped"];
const NOT_A_RESULT = ["cancelled", "stale"];

/** What a head's checks say, in the words the review pipeline publishes as `ci.status`. */
export function ciState(checks: CheckSummary[]): "passing" | "failing" | "pending" | "none" {
  if (checks.length === 0) return "none";
  const settled = (c: CheckSummary) =>
    c.status === "completed" && c.conclusion !== null && !NOT_A_RESULT.includes(c.conclusion);
  if (checks.some((c) => settled(c) && !GREEN.includes(c.conclusion!))) return "failing";
  return checks.every(settled) ? "passing" : "pending";
}

/**
 * The CI state of every pull request waiting in review, read from GitHub, so a
 * board that loads after the `ci.status` event went by still knows. Looked up in
 * parallel; a lookup that fails leaves its card out, which reads as unknown.
 */
export async function seedReviewCi(client: VcsClient, cards: BoardCard[]): Promise<ExtrasMap> {
  const inReview = cards.filter((c) => c.status === "review" && c.prNumber !== null);
  const found = await Promise.all(
    inReview.map(async (card) => {
      try {
        const pull = await client.pullRequest(card.prNumber!);
        return [card.id, ciState(await client.checksFor(pull.headSha))] as const;
      } catch {
        return null;
      }
    }),
  );
  const extras: ExtrasMap = {};
  for (const entry of found) if (entry) extras[entry[0]] = { ci: entry[1] };
  return extras;
}
