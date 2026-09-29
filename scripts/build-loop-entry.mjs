#!/usr/bin/env node
/**
 * Builds the loop entry into one file, for a GitHub Actions job to fetch.
 *
 * `src/lib/runner/loop-entry.ts` is TypeScript in this repository, and a job in
 * someone else's repository does not have it, this repository's dependencies,
 * or a bundler. This produces the single file that job runs. See
 * docs/long-runs.md.
 *
 * Two things it does that are easy to get wrong:
 *
 * - `server-only` throws when imported outside a React Server Component, and
 *   the loop imports it. It is aliased to the same no-op stub
 *   `vitest.config.ts` uses, which is why the loop runs anywhere Node runs.
 * - The build records the commit it was built from, in a banner inside the
 *   file and in the sidecar the bundle route reports, so a job cannot be
 *   running code nobody can identify.
 *
 * Runs from `npm run build`, before `next build`, and writes into
 * `src/generated/` — the same place Prisma's client goes, and gitignored.
 * `node scripts/build-loop-entry.mjs [outDir]` builds somewhere else, which is
 * how its test checks the output.
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.resolve(
  process.argv[2] ?? process.env.FORMIC_LOOP_ENTRY_OUT ?? path.join(root, "src/generated/loop-entry"),
);

/** The commit this was built from, whichever way the build was told. */
function builtFrom() {
  const declared = process.env.FORMIC_BUILD_COMMIT?.trim();
  if (declared) return declared;
  // Vercel's build, then Actions, then a checkout of our own.
  const platform = process.env.VERCEL_GIT_COMMIT_SHA?.trim() ?? process.env.GITHUB_SHA?.trim();
  if (platform) return platform;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const commit = builtFrom();
const builtAt = new Date().toISOString();
const banner = `formic loop entry — commit ${commit} — built ${builtAt}`;

await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "src/lib/runner/loop-entry.ts")],
  outfile: path.join(outDir, "loop-entry.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  banner: { js: `// ${banner}` },
  alias: { "server-only": path.join(root, "src/test/server-only-stub.ts") },
  metafile: true,
  logLevel: "warning",
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
await writeFile(
  path.join(outDir, "loop-entry.json"),
  `${JSON.stringify({ commit, builtAt, bytes }, null, 2)}\n`,
);

process.stdout.write(`Built the loop entry for ${commit}: ${bytes} bytes in ${outDir}\n`);
