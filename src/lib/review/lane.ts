/**
 * The serialized merge lane.
 *
 * The MVP merges sequentially, and that is not an arbitrary simplification:
 * two agents merging concurrently means the second one merges a base branch
 * it never tested against. One lane per project, strictly ordered, so every
 * merge is rebased on the result of the one before it.
 *
 * Pure module: no I/O, so the ordering is testable without a database.
 */

const lanes = new Map<string, Promise<unknown>>();
const depths = new Map<string, number>();

export function laneDepth(key: string): number {
  return depths.get(key) ?? 0;
}

/**
 * Runs `work` after everything already queued under `key` has finished,
 * whether it succeeded or not. A failed entry must not wedge the lane.
 */
export function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  depths.set(key, laneDepth(key) + 1);

  const previous = lanes.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);

  // The lane itself must never reject, or every later entry inherits the
  // rejection. The caller still sees its own result through `next`.
  lanes.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );

  return next.finally(() => {
    depths.set(key, Math.max(laneDepth(key) - 1, 0));
    if (laneDepth(key) === 0) lanes.delete(key);
  });
}

/** Exactly one merge in flight per project. */
export function inMergeLane<T>(
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  return serialize(`merge:${projectId}`, work);
}

export function mergeLaneDepth(projectId: string): number {
  return laneDepth(`merge:${projectId}`);
}

/**
 * Exactly one reaction in flight per ticket. A commit that finishes four
 * checks arrives as four webhooks, and without this they would all open a
 * sandbox for the same pull request at the same time.
 */
export function inTicketLane<T>(
  ticketId: string,
  work: () => Promise<T>,
): Promise<T> {
  return serialize(`ticket:${ticketId}`, work);
}

/** Test seam. */
export function resetMergeLanes(): void {
  lanes.clear();
  depths.clear();
}
