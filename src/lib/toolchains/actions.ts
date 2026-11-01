import { TOOLCHAINS, cacheFor, setupScript, type Toolchain } from "./index";

/**
 * The toolchains, as GitHub Actions YAML: the cache step the runner's workflow
 * and the checks workflow share, and the checks workflow itself.
 */

/** Pinned by commit, like every action Formic writes into a repository. */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
export const CACHE_ACTION = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0";

/**
 * The repository variable that moves Formic's jobs onto the repository's own
 * machine: set it to a runner label (`self-hosted`) and the runner workflow
 * and the checks workflow run there, free of Actions minutes. Unset, they run
 * on GitHub's machines. A variable, not a Formic setting, so CI follows it too
 * and switching back is deleting it on GitHub.
 */
export const RUNNER_LABEL_VAR = "FORMIC_RUNNER";

/** A job's `runs-on`: the repository's own machine when it names one. */
export const RUNS_ON = `\${{ vars.${RUNNER_LABEL_VAR} || 'ubuntu-latest' }}`;

/** Formic's proposed CI, for a repository that has none. */
export const CHECKS_WORKFLOW_PATH = ".github/workflows/formic-checks.yml";

/**
 * The cache steps for these toolchains, at a step list's indentation (six
 * spaces): one for what they install, and one per toolchain that carries work
 * in the checkout (`checkoutCache`).
 *
 * Work in the checkout is keyed by the run, not by files: it changes with
 * nearly every run, and a cache whose key hits is never saved again, so a
 * file key would keep restoring the first run's work forever. Each run saves
 * its own and the next restores the newest. Gated on the toolchain's markers,
 * so a repository that does not use it gets no warning about a missing path.
 */
export function cacheStep(toolchains: readonly Toolchain[] = TOOLCHAINS): string {
  const { paths, keyFiles } = cacheFor(toolchains);
  const installs = `      - uses: ${CACHE_ACTION}
        with:
          path: |
${paths.map((p) => `            ${p}`).join("\n")}
          key: formic-\${{ runner.os }}-\${{ hashFiles(${keyFiles.map((f) => `'${f}'`).join(", ")}) }}
          restore-keys: formic-\${{ runner.os }}-`;
  const work = toolchains
    .filter((t) => t.checkoutCache?.length)
    .map(
      (t) => `      # ${t.name}'s work on this checkout, from the newest run before this one.
      - uses: ${CACHE_ACTION}
        if: ${t.markers.map((m) => `hashFiles('${m}') != ''`).join(" || ")}
        with:
          path: |
${t.checkoutCache!.map((p) => `            ${p}`).join("\n")}
          key: formic-${t.id}-work-\${{ runner.os }}-\${{ github.run_id }}-\${{ github.run_attempt }}
          restore-keys: formic-${t.id}-work-\${{ runner.os }}-`,
    );
  return [installs, ...work].join("\n\n");
}

/**
 * The CI workflow the setup pull request proposes to a repository with no CI
 * of its own, or null when none of its toolchains has checks to propose.
 * Without CI the Reviewer Agent has nothing to read: a pull request with no
 * checks counts as done, whether or not the change works.
 *
 * Once merged it is the repository's file, to change as it likes. Formic never
 * replaces it, and proposes nothing once the repository has CI.
 */
export function checksWorkflow(toolchains: readonly Toolchain[], baseBranch: string): string | null {
  const checked = toolchains.filter((t) => t.ci);
  if (checked.length === 0) return null;
  const setup = setupScript("job", toolchains)
    .trimEnd()
    .split("\n")
    .map((line) => (line ? `          ${line}` : line))
    .join("\n");
  return `# Proposed by Formic (https://formic-board.vercel.app) for ${checked.map((t) => t.name).join(" and ")}.
# Runs this project's checks on every pull request, so Formic's Reviewer Agent
# can tell a change that works from one that does not. It is yours now: edit it
# as you like. Formic never replaces it.
name: Checks

on:
  pull_request:
  push:
    branches: [${JSON.stringify(baseBranch)}]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  checks:
    runs-on: ${RUNS_ON}
    timeout-minutes: 60
    steps:
      - uses: ${CHECKOUT_ACTION}
        with:
          persist-credentials: false

${cacheStep(toolchains)}

      # The same setup Formic's agents get, so CI and the agent run the same engine.
      - name: Set up the project
        run: |
${setup}

${checked.map((t) => t.ci).join("\n\n")}
`;
}
