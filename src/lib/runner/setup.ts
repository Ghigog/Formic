import "server-only";

import { credentialsForProject } from "@/lib/auth/credentials";
import type { ProjectSummary } from "@/lib/db/repository";
import { vcs, VcsError } from "@/lib/vcs";
import { boardHasCliAgent } from "@/lib/board/first-agent";
import { closeStaleSetupPulls, ensureRunner, explain } from "./runner";
import { RUNNER_WORKFLOW_PATH, runnerSetupBranch, runnerVersion } from "./workflow";

/**
 * Where a project stands on the one pull request a person has to merge
 * before CLI agents can run in its repository: the board asks on load, so
 * the request comes up front rather than as a card's error.
 */
export type RunnerSetup =
  | { state: "ready" }
  /**
   * Nothing is installed and no pull request is open: the person is asked
   * before Formic opens one. `plans` when an agent on the board runs on a
   * plan (Claude Code, Codex, Gemini CLI), which only runs in GitHub Actions,
   * so bringing an E2B key instead is not an option.
   */
  | { state: "ask"; plans: boolean }
  /** `update` when an older version of the workflow is on the base branch. */
  | { state: "waiting"; setupUrl: string; update: boolean }
  /** Formic cannot open the pull request: usually the GitHub App's permissions. */
  | { state: "blocked"; reason: string };

/**
 * Checks the base branch. A new repository is asked first: the setup pull
 * request is opened only with `approve`, when the person has said yes. An
 * update to a workflow they already merged is opened without asking. Cheap
 * when the board polls it: two reads while a pull request is already open,
 * one once it has merged.
 *
 * Someone with their own E2B key whose agents are all on API keys needs no
 * workflow: their agents work in E2B sandboxes instead.
 */
export async function runnerSetup(
  project: ProjectSummary,
  { approve = false }: { approve?: boolean } = {},
): Promise<RunnerSetup> {
  // With no repository there is nothing to install, and GitHub is not asked.
  if (!project.repoFullName) return { state: "ready" };
  const creds = await credentialsForProject(project);
  // No GitHub token means the mock repository: nothing to install.
  if (!creds.githubToken) return { state: "ready" };
  const client = vcs(project.repoFullName, creds.githubToken);

  try {
    await closeStaleSetupPulls(client);
    const current = await client.readFile(RUNNER_WORKFLOW_PATH, project.baseBranch);
    if (current?.includes(runnerVersion())) return { state: "ready" };
    const open = await client.findPullRequest(runnerSetupBranch());
    if (open) return { state: "waiting", setupUrl: open.url, update: current !== null };

    if (current === null && !approve) {
      const plans = await boardHasCliAgent(project.id);
      const ownE2b = !!creds.e2bKey && creds.e2bFallbackUserId === null;
      if (!plans && ownE2b) return { state: "ready" };
      return { state: "ask", plans };
    }

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
