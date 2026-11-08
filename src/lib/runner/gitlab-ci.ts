/**
 * The GitLab CI side of the runner: the names the config, the client and the
 * pipelines it starts agree on. The config itself is built in
 * ./gitlab-ci-config.ts.
 *
 * No server imports: the client and the setup read these too.
 */

/** The job Formic adds to a project's pipelines. Its status is the run's. */
export const GITLAB_RUNNER_JOB = "formic-agent";

/** Formic's own CI file, which the project's .gitlab-ci.yml includes. */
export const GITLAB_RUNNER_PATH = ".gitlab/formic-agent.yml";

/** The project's CI entry point, which GitLab reads. */
export const GITLAB_CI_PATH = ".gitlab-ci.yml";

/**
 * Pipeline variables carry a run's inputs, each as FORMIC_<INPUT>: the same
 * inputs GitHub's workflow takes (job, mode, ticket, cli, model, from,
 * secret, prompt, report, merge, timeout). FORMIC_RUN marks a pipeline as
 * Formic's, which is what makes the agent's job run in it at all.
 */
export const GITLAB_RUN_VARIABLE = "FORMIC_RUN";

export function gitlabInputVariable(input: string): string {
  return `FORMIC_${input.toUpperCase()}`;
}

/** Where a card's checkpoint lives on GitLab: a branch, since the API makes no other refs. */
export const GITLAB_CHECKPOINT_PREFIX = "formic-checkpoints/";

/** Added to a checkpoint commit so saving it starts no pipeline; taken off when it is read. */
export const SKIP_CI_LINE = "[skip ci]";
