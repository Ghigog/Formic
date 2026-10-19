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

/**
 * The merge slot: which ticket may bring the base in, held from then until it
 * merges or drops out, across the CI run in between.
 *
 * The lane above orders the moments of merging, a few seconds each, and lets
 * go before CI on the new head has run. On its own, every approved, green pull
 * request takes its turn, brings the base in and leaves to wait for CI, and
 * the next merge moves the base under all of them again: each brings it in
 * again and runs CI again, and a busy board spends a CI run on every waiting
 * pull request for every merge, while the unlucky one never lands. With the
 * slot, one pull request at a time brings the base in. The rest wait as they
 * are, green on their own heads, until it is their turn.
 *
 * A lease named by the ticket, keyed like the lane: the holder renews it each
 * time it is reported on, and one that went quiet (CI that never reported)
 * lets the next one in once it lapses.
 */
const SLOT_TTL_MS = 20 * 60 * 1000;

/** The repository and branch a board merges into, as one key: what every merge lease is per. */
async function laneOf(projectId: string): Promise<string | null> {
  const project = await repository().projectById(projectId);
  if (!project) return null;
  return `${repoKey(project.repoFullName)}:${mergeTarget(project.baseBranch)}`;
}

async function slotKey(projectId: string): Promise<string | null> {
  const lane = await laneOf(projectId);
  return lane && `merge-slot:${lane}`;
}

/**
 * Takes the merge slot for `ticketId`, or renews it if it is theirs. False
 * while another ticket is still merging through it.
 */
export async function claimMergeSlot(projectId: string, ticketId: string): Promise<boolean> {
  const repo = repository();
  const key = await slotKey(projectId);
  if (!key) return true;
  for (let i = 0; i < 2; i++) {
    if (await repo.acquireLease(key, ticketId, SLOT_TTL_MS)) return true;
    const holder = await repo.leaseHolder(key);
    if (!holder) continue;
    const ahead = await repo.ticketDetail(holder);
    if (ahead && ahead.status === "review" && ahead.prNumber !== null) return false;
    // Merged, closed, sent back or parked somewhere nothing let go of the
    // slot (a person on GitHub, an instance that died): it is not merging.
    await repo.releaseLease(key, holder);
  }
  return false;
}

/** Lets go of the merge slot if `ticketId` has it. True when it did. */
export async function releaseMergeSlot(projectId: string, ticketId: string): Promise<boolean> {
  const repo = repository();
  const key = await slotKey(projectId);
  if (!key || (await repo.leaseHolder(key)) !== ticketId) return false;
  await repo.releaseLease(key, ticketId);
  return true;
}

/**
 * A merge batch: several approved, green pull requests merged together onto
 * the target on a branch of their own, so one CI run tests them all as they
 * will land. While it is open the slot stays with its first member.
 *
 * Kept as a lease, with the batch itself as the holder, so it is one row any
 * instance can read, written only by whoever holds the merge lane, and gone
 * by itself if everything that would end it dies.
 */
export interface MergeBatch {
  projectId: string;
  /** The pull request that runs CI on the batch branch. */
  pr: number;
  branch: string;
  /** The target's head the batch was built on, and after each member lands, that merge's. */
  targetSha: string;
  /** In the order they were merged onto the batch branch, which is the order they land. */
  members: Array<{ ticketId: string; key: string; prNumber: number; headSha: string }>;
}

const BATCH_TTL_MS = 2 * 60 * 60 * 1000;

async function batchKey(projectId: string): Promise<string | null> {
  const lane = await laneOf(projectId);
  return lane && `merge-batch:${lane}`;
}

/** The batch open on this board's merge target, if there is one. */
export async function openBatch(projectId: string): Promise<MergeBatch | null> {
  const key = await batchKey(projectId);
  const held = key && (await repository().leaseHolder(key));
  if (!held) return null;
  try {
    return JSON.parse(held) as MergeBatch;
  } catch {
    return null;
  }
}

/** Records `next` in place of `previous` (null to open one). False when another batch is open. */
export async function recordBatch(projectId: string, next: MergeBatch, previous: MergeBatch | null): Promise<boolean> {
  const repo = repository();
  const key = await batchKey(projectId);
  if (!key) return false;
  if (previous) await repo.releaseLease(key, JSON.stringify(previous));
  return repo.acquireLease(key, JSON.stringify(next), BATCH_TTL_MS);
}

export async function closeBatchRecord(projectId: string, batch: MergeBatch): Promise<void> {
  const key = await batchKey(projectId);
  if (key) await repository().releaseLease(key, JSON.stringify(batch));
}

/**
 * A head that was in a batch whose CI failed merges on its own from then on,
 * so the one that broke it goes back through review with its own CI, rather
 * than every batch it joins failing for the same reason. A new head is a new
 * change, and may join a batch again.
 */
const SOLO_TTL_MS = 24 * 60 * 60 * 1000;

export async function mergeAlone(ticketId: string, headSha: string): Promise<void> {
  await repository().acquireLease(`merge-solo:${ticketId}:${headSha}`, "solo", SOLO_TTL_MS);
}

export async function mustMergeAlone(ticketId: string, headSha: string): Promise<boolean> {
  return (await repository().leaseHolder(`merge-solo:${ticketId}:${headSha}`)) !== null;
}
