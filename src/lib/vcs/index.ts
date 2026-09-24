import "server-only";

import { GitHubClient } from "./github";
import { MockVcsClient } from "./mock";
import type { VcsClient } from "./types";
import { env } from "@/lib/secrets/env";

/**
 * Provider selection, and the one policy decision in PROT-07 worth arguing
 * about: what an agent is allowed to merge into.
 *
 * A ticket is Done when its code is on the project's base branch, so that is
 * where agents merge, behind the Reviewer Agent and green CI. A deployment
 * that wants a person between agents and the base branch sets
 * MERGE_TARGET=integration: agents then merge into formic/integration, and
 * promoting it is that person's click.
 */

export const INTEGRATION_BRANCH = "formic/integration";

let override: VcsClient | null = null;

/**
 * Whether the server has its own GitHub credential. Only meaningful in local
 * mode; signed in with GitHub, each project uses its owner's token instead.
 */
export function usingMockVcs(): boolean {
  if (override) return override.name === "mock";
  return !env().GITHUB_TOKEN;
}

/**
 * The GitHub client for a repository, acting with a given token. No token
 * means no GitHub: the mock, so the board still runs end to end.
 */
export function vcs(repoFullName: string, token: string | null): VcsClient {
  if (override) return override;
  return token ? new GitHubClient(repoFullName, token) : new MockVcsClient(repoFullName);
}

/** Test seam: every repository gets this client. */
export function setVcs(client: VcsClient): void {
  override = client;
}

/** Test seam. */
export function resetVcs(): void {
  override = null;
}

/** The branch agents may merge into without a human. */
export function mergeTarget(baseBranch: string): string {
  return env().MERGE_TARGET === "integration" ? INTEGRATION_BRANCH : baseBranch;
}

export function mergeNeedsPromotion(baseBranch: string): boolean {
  return mergeTarget(baseBranch) !== baseBranch;
}

export * from "./types";
export { MockVcsClient } from "./mock";
