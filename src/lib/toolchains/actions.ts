import { cacheFor, setupScript, type Toolchain } from "./index";

/**
 * The toolchains, as GitHub Actions YAML: the cache step the runner's workflow
 * and the checks workflow share, and the checks workflow itself.
 */

/** Pinned by commit, like every action Formic writes into a repository. */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
export const CACHE_ACTION = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0";

/** Formic's proposed CI, for a repository that has none. */
export const CHECKS_WORKFLOW_PATH = ".github/workflows/formic-checks.yml";

/** The cache step for these toolchains, at a step list's indentation (six spaces). */
export function cacheStep(toolchains?: readonly Toolchain[]): string {
  const { paths, keyFiles } = cacheFor(toolchains);
  return `      - uses: ${CACHE_ACTION}
        with:
          path: |
${paths.map((p) => `            ${p}`).join("\n")}
          key: formic-\${{ runner.os }}-\${{ hashFiles(${keyFiles.map((f) => `'${f}'`).join(", ")}) }}
          restore-keys: formic-\${{ runner.os }}-`;
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
    runs-on: ubuntu-latest
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
