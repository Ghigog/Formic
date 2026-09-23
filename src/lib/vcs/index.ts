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

/** One client per repository: each project on the board is its own repo. */
const clients = new Map<string, VcsClient>();
let override: VcsClient | null = null;

/**
 * Real GitHub whenever there is a token. The repository comes from the
 * project picked on the board, so GITHUB_REPO is only the default project.
 */
export function usingMockVcs(): boolean {
  if (override) return override.name === "mock";
  return !env().GITHUB_TOKEN;
}

export function vcs(repoFullName: string): VcsClient {
  if (override) return override;
  let client = clients.get(repoFullName);
  if (!client) {
    client = usingMockVcs()
      ? new MockVcsClient(repoFullName)
      : new GitHubClient(repoFullName);
    clients.set(repoFullName, client);
  }
  return client;
}

/** Test seam: every repository gets this client. */
export function setVcs(client: VcsClient): void {
  override = client;
}

/** Test seam. */
export function resetVcs(): void {
  override = null;
  clients.clear();
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
