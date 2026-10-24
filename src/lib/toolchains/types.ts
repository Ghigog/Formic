/**
 * A toolchain: what a project of one kind needs on a fresh machine before an
 * agent can build and test it, and how to check its work once it has.
 *
 * Every machine an agent works on is a fresh one: the job a workflow run gets,
 * and the E2B sandbox an in-process run clones into. Neither has a project's
 * engine, compiler or packages on it. A toolchain is how Formic notices which
 * of those a repository needs, from files at its root, and puts them there.
 *
 * Adding one is a file in this folder and a line in ./index.ts. Nothing else
 * in Formic names a toolchain: the runner's workflow, the CI workflow the setup
 * pull request proposes and the sandbox all read the list.
 */

/**
 * Where setup runs. `job` is the repository's GitHub Actions job (the runner,
 * and the CI workflow): an hour, a cache, the place work is moving to. `sandbox`
 * is an in-process run's E2B sandbox: minutes, no cache, every second paid for.
 */
export type Host = "job" | "sandbox";

export interface Toolchain {
  /** Stable, short, lowercase: it appears in workflow comments and logs. */
  readonly id: string;
  /** What a person calls it. */
  readonly name: string;
  /**
   * Files at the repository root, any one of which means the project uses
   * this toolchain. Read twice: by bash on the machine (`[ -f ... ]`) and by
   * Formic against the repository's tree, so they must be plain paths.
   */
  readonly markers: readonly string[];
  /**
   * Bash that installs it, run from the repository root when a marker is
   * there, or null when this host does nothing for it. It runs in a subshell
   * of its own, so a failure here never stops another toolchain's setup, and
   * may use the helpers `formic_bin` and `formic_note` (see ./index).
   */
  setup(host: Host): string | null;
  /**
   * Bash that readies the project once everything is installed: every
   * toolchain's setup and the repository's own hook (REPO_SETUP_HOOK) have
   * run, so it sees the files a hook fetched. Same rules as `setup`.
   */
  prepare?(host: Host): string | null;
  /**
   * Paths under the job's home to carry from one run to the next (an engine's
   * download, a package store), and the root files whose content decides when
   * that cache is stale.
   */
  readonly cache?: { readonly paths: readonly string[]; readonly keyFiles: readonly string[] };
  /**
   * The CI workflow's steps for this toolchain, as GitHub Actions YAML at a
   * step list's indentation (six spaces), run after setup. Null when Formic
   * has nothing to propose: such a repository brings its own CI.
   */
  readonly ci: string | null;
}
