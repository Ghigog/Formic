import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

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
    const { commit, builtAt } = JSON.parse(meta) as { commit?: string; builtAt?: string };
    return {
      code,
      commit: commit?.trim() || "unknown",
      builtAt: builtAt?.trim() || "",
    };
  } catch {
    return null;
  }
}
