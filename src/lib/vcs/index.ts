import "server-only";

import { GitHubClient } from "./github";
import { MockVcsClient } from "./mock";
import type { VcsClient } from "./types";
import { env } from "@/lib/secrets/env";

/**
 * Provider selection, and the one policy decision in PROT-07 worth arguing
 * about: what an agent is allowed to merge into.
 *
 * The PRD says the colony merges to the default branch unattended. That is
 * defensible on a throwaway repository and indefensible on one with users, so
 * the default here is an integration branch and promoting it to the base
 * branch is a human's click. MERGE_TARGET=base opts out, deliberately and in
 * one place.
 */

export const INTEGRATION_BRANCH = "formic/integration";

let cached: VcsClient | null = null;

export function usingMockVcs(): boolean {
  return !env().GITHUB_TOKEN || !env().GITHUB_REPO;
}

export function vcs(repoFullName: string): VcsClient {
  if (cached) return cached;
  cached = usingMockVcs()
    ? new MockVcsClient(repoFullName)
    : new GitHubClient(repoFullName);
  return cached;
}

export function setVcs(client: VcsClient): void {
  cached = client;
}

/** Test seam. */
export function resetVcs(): void {
  cached = null;
}

/** The branch agents may merge into without a human. */
export function mergeTarget(baseBranch: string): string {
  return env().MERGE_TARGET === "base" ? baseBranch : INTEGRATION_BRANCH;
}

export function mergeNeedsPromotion(baseBranch: string): boolean {
  return mergeTarget(baseBranch) !== baseBranch;
}

export * from "./types";
export { MockVcsClient } from "./mock";
