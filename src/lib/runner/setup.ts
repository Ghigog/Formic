import "server-only";

import { credentialsForProject } from "@/lib/auth/credentials";
import type { ProjectSummary } from "@/lib/db/repository";
import { vcs, VcsError } from "@/lib/vcs";
import { closeStaleSetupPulls, ensureRunner, explain } from "./runner";
import { RUNNER_SETUP_BRANCH, RUNNER_VERSION, RUNNER_WORKFLOW_PATH } from "./workflow";

/**
 * Where a project stands on the one pull request a person has to merge
 * before CLI agents can run in its repository: the board asks on load, so
 * the request comes up front rather than as a card's error.
 */
export type RunnerSetup =
  | { state: "ready" }
  /** `update` when an older version of the workflow is on the base branch. */
  | { state: "waiting"; setupUrl: string; update: boolean }
  /** Formic cannot open the pull request: usually the GitHub App's permissions. */
  | { state: "blocked"; reason: string };

/**
 * Checks the base branch, and opens the setup pull request if there is none
 * yet. Cheap when the board polls it: two reads while a pull request is
 * already open, one once it has merged.
 */
export async function runnerSetup(project: ProjectSummary): Promise<RunnerSetup> {
  const creds = await credentialsForProject(project);
  // No GitHub token means the mock repository: nothing to install.
  if (!creds.githubToken) return { state: "ready" };
  const client = vcs(project.repoFullName, creds.githubToken);

  try {
    await closeStaleSetupPulls(client);
    const current = await client.readFile(RUNNER_WORKFLOW_PATH, project.baseBranch);
    if (current?.includes(RUNNER_VERSION)) return { state: "ready" };
    const open = await client.findPullRequest(RUNNER_SETUP_BRANCH);
    if (open) return { state: "waiting", setupUrl: open.url, update: current !== null };

    const runner = await ensureRunner(client, project.baseBranch);
    return runner.ready
      ? { state: "ready" }
      : { state: "waiting", setupUrl: runner.setupUrl, update: runner.update };
  } catch (e) {
    if (e instanceof VcsError && (e.status === 403 || e.status === 404)) {
      return { state: "blocked", reason: explain(e) };
    }
    throw e;
  }
}
