import "server-only";

import { repository } from "@/lib/db";
import { LeaseBusy, repoKey, withLease } from "@/lib/board/lease";
import { mergeTarget } from "@/lib/vcs";
import { inMergeLane } from "./lane";

/**
 * The merge queue: exactly one merge in flight per branch being merged into,
 * whichever board asks and whichever server instance it lands on.
 *
 * Keyed on the repository and the branch merged into, not on the board. Two
 * people's boards on one repository merge into the same branch, and a merge
 * that has not seen the one before it lands a base nobody tested against.
 * Each entry brings the base in, waits for CI on the result, and only then
 * merges that exact head (see mergeTicket), so the queue fails closed: a
 * conflict goes to the Reviewer Agent and red CI goes back through review,
 * with its logs, rather than through to the branch.
 */
export async function inRepoMergeLane<T>(
  projectId: string,
  work: () => Promise<T>,
  busy: (reason: string) => T,
): Promise<T> {
  const project = await repository().projectById(projectId);
  if (!project) return inMergeLane(projectId, work);
  const target = mergeTarget(project.baseBranch);
  try {
    return await withLease(`merge:${repoKey(project.repoFullName)}:${target}`, work, {
      ttlMs: 5 * 60 * 1000,
      waitMs: 90 * 1000,
    });
  } catch (e) {
    // The pull request sweep comes back to an approved, green one on its
    // own, so a merge that could not get in line now is only late.
    if (e instanceof LeaseBusy) {
      return busy(`Another merge into ${target} is in flight; this one goes once it is done.`);
    }
    throw e;
  }
}
