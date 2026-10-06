import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { runnerSetupBranch, runnerVersion, runnerWorkflow } from "./workflow";

/**
 * The loop entry as one file, for a job in someone else's repository to run.
 *
 * The file is a build artifact, not source: `scripts/build-loop-entry.mjs`
 * produces it before `next build` and this reads it, so what a job runs is
 * always a build of the commit being deployed. Where the artifact is missing —
 * a development server, or a deploy whose build did not produce one — this
 * says so, and the route answers 503 rather than serving an empty script the
 * job would run to no effect.
 */

/** Where the build leaves it, relative to the working directory. */
export const LOOP_BUNDLE_DIR = path.join("src", "generated", "loop-entry");

export interface LoopBundle {
  /** The entry, as one runnable ES module. */
  code: string;
  /** The commit it was built from, for the run record. */
  commit: string;
  /** When it was built, ISO. */
  builtAt: string;
  /**
   * The entry's code, hashed — what a repository's workflow names as the entry
   * it needs, so that the pair of files installed together is one version. It
   * is a hash of the code and not of this build of it (the banner is not in
   * it), so rebuilding one source does not make every repository out of date.
   */
  hash: string;
}

let override: string | null = null;

/**
 * Test seam, in the same shape as setVcs and setCheckoutFactory: lets a test
 * point the route at a bundle it built itself.
 */
export function setLoopBundleDir(dir: string | null): void {
  override = dir;
}

export async function loopBundle(dir?: string): Promise<LoopBundle | null> {
  const where = dir ?? override ?? path.join(process.cwd(), LOOP_BUNDLE_DIR);
  try {
    const [code, meta] = await Promise.all([
      readFile(path.join(where, "loop-entry.mjs"), "utf8"),
      readFile(path.join(where, "loop-entry.json"), "utf8"),
    ]);
    if (!code.trim()) return null;
    const { commit, builtAt, hash } = JSON.parse(meta) as {
      commit?: string;
      builtAt?: string;
      hash?: string;
    };
    return {
      code,
      commit: commit?.trim() || "unknown",
      builtAt: builtAt?.trim() || "",
      hash: hash?.trim() || "",
    };
  } catch {
    return null;
  }
}

/**
 * The hash of the entry this build produced, reading only the sidecar. The
 * workflow is versioned with it, and that version is checked on every board
 * read, so the check must not read three quarters of a megabyte of JavaScript
 * to do it.
 */
export async function loopEntryHash(dir?: string): Promise<string | null> {
  const where = dir ?? override ?? path.join(process.cwd(), LOOP_BUNDLE_DIR);
  try {
    const meta = JSON.parse(await readFile(path.join(where, "loop-entry.json"), "utf8")) as {
      hash?: string;
    };
    return meta.hash?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The pair this build installs in a repository, and how they are named: the
 * workflow (versioned with the entry beside it), the entry's hash, and the
 * version and setup branch that go with them. `ensureRunner` writes these; the
 * tests install them, so that what a test sets up is what a board would.
 */
export async function currentRunnerFiles(): Promise<{
  hash: string | null;
  version: string;
  branch: string;
  workflow: string;
}> {
  const hash = await loopEntryHash();
  return {
    hash,
    version: runnerVersion(hash),
    branch: runnerSetupBranch(hash),
    workflow: runnerWorkflow(hash),
  };
}
