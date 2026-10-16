import "server-only";

import { randomUUID } from "node:crypto";
import { repository } from "@/lib/db";
import { serialize } from "@/lib/review/lane";

/**
 * One holder at a time per key, across every server instance.
 *
 * An in-process lane (src/lib/review/lane.ts) serializes the work one process
 * does, and that was the whole story while Formic ran as one process. It does
 * not run as one any more: on Vercel each request can land on its own
 * instance, and two webhooks for two boards on one repository arrive together.
 * So the lane still orders the callers in this process, and a lease in the
 * database decides between processes.
 *
 * Never take a lease from inside work holding the same key: the inner call
 * waits on the outer one, which waits on it.
 */

export class LeaseBusy extends Error {
  constructor(readonly key: string) {
    super(`Another instance is holding ${key}.`);
    this.name = "LeaseBusy";
  }
}

export interface LeaseOptions {
  /** How long a holder that died keeps others out. Renewed while the work runs. */
  ttlMs?: number;
  /** How long to wait for another holder before giving up with LeaseBusy. */
  waitMs?: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_WAIT_MS = 60 * 1000;
const FIRST_PAUSE_MS = 50;
const LONGEST_PAUSE_MS = 2_000;

export function withLease<T>(key: string, work: () => Promise<T>, options: LeaseOptions = {}): Promise<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  return serialize(`lease:${key}`, async () => {
    const repo = repository();
    const holder = randomUUID();
    const deadline = Date.now() + waitMs;
    let pause = FIRST_PAUSE_MS;
    while (!(await repo.acquireLease(key, holder, ttlMs))) {
      if (Date.now() + pause > deadline) throw new LeaseBusy(key);
      await new Promise((r) => setTimeout(r, pause));
      pause = Math.min(pause * 2, LONGEST_PAUSE_MS);
    }
    // Work that outlives the lease would let a second holder in beside it.
    const renew = setInterval(() => {
      void repo.acquireLease(key, holder, ttlMs).catch(() => undefined);
    }, Math.max(ttlMs / 3, 1_000));
    renew.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(renew);
      await repo.releaseLease(key, holder).catch(() => undefined);
    }
  });
}

/** Repositories are named case-insensitively on GitHub, so their keys are too. */
export function repoKey(repoFullName: string): string {
  return repoFullName.toLowerCase();
}
