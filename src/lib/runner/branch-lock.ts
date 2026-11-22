import "server-only";

import { repository } from "@/lib/db";

/**
 * One writer per branch (docs/plans/pm-chat.md, safety row 4): a ticket's
 * agent run and the board's PM never push to the same branch at once.
 *
 * A ticket run holds its branch for as long as its job may run; the PM holds
 * one only while Formic moves it, for seconds. Both are leases in the
 * database, so they hold across processes, and both expire: a run that
 * crashed never wedges a branch. A ticket run that finds the PM holding its
 * branch waits a moment for it; the PM never waits on a run, it keeps its
 * change on a branch of its own instead.
 */

/** The PM's hold: one fast-forward. */
export const PM_LOCK_MS = 2 * 60 * 1000;
/** How long a ticket run waits for the PM to finish moving its branch. */
export const RUN_WAIT_MS = 60 * 1000;

const keyOf = (projectId: string, branch: string) => `branch:${projectId}:${branch}`;

/** A ticket run's hold, by its job. */
export const runHolder = (job: string) => `run:${job}`;
/** The PM's hold, by the job of its turn. */
export const pmHolder = (job: string) => `pm:${job}`;

/** Takes `branch` for `holder` for `ttlMs`; true when it is theirs now. */
export function lockBranch(projectId: string, branch: string, holder: string, ttlMs: number): Promise<boolean> {
  return repository().acquireLease(keyOf(projectId, branch), holder, ttlMs);
}

/** Lets go of `branch`, only if `holder` still has it. */
export function unlockBranch(projectId: string, branch: string, holder: string): Promise<void> {
  return repository().releaseLease(keyOf(projectId, branch), holder);
}

/** Who holds `branch` now, or null. */
export function branchHolder(projectId: string, branch: string): Promise<string | null> {
  return repository().leaseHolder(keyOf(projectId, branch));
}

/**
 * A ticket run takes its branch for the length of its job, waiting up to
 * `waitMs` while the PM is moving it. Gives up waiting rather than failing
 * the run: the PM's hold is only ever seconds, and it expires.
 */
export async function lockForRun(
  projectId: string,
  branch: string,
  job: string,
  ttlMs: number,
  options: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.waitMs ?? RUN_WAIT_MS);
  for (;;) {
    if (await lockBranch(projectId, branch, runHolder(job), ttlMs)) return true;
    const holder = await branchHolder(projectId, branch);
    // Another run's hold (a retry racing the run it replaces) is not the PM's: the newer run takes over.
    if (holder && !holder.startsWith("pm:")) {
      await repository().releaseLease(keyOf(projectId, branch), holder);
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(2_000);
  }
}
