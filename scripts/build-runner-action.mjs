#!/usr/bin/env node
/**
 * Builds the runner Action: `runner-action/dist/index.mjs`, from the readable
 * source in `src/lib/runner/loop-entry.ts`.
 *
 * The output is meant to be read. It is not minified, keeps function names, and
 * comes with a source map, so a repository owner can review what runs in their
 * Actions. See runner-action/README.md.
 *
 * Two things it does that are easy to get wrong:
 *
 * - `server-only` throws when imported outside a React Server Component, and
 *   the loop imports it. It is aliased to the same no-op stub
 *   `vitest.config.ts` uses, which is why the loop runs anywhere Node runs.
 * - The build records the commit it was built from in a banner at the top of
 *   the file, so a job cannot be running code nobody can identify.
 *
 * `node scripts/build-runner-action.mjs [outDir]` builds somewhere else, which
 * is how its test checks the output.
 */

import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.resolve(
  process.argv[2] ?? process.env.FORMIC_RUNNER_ACTION_OUT ?? path.join(root, "runner-action/dist"),
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

await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "src/lib/runner/loop-entry.ts")],
  outfile: path.join(outDir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  keepNames: true,
  sourcemap: true,
  legalComments: "inline",
  banner: { js: `// formic runner action — commit ${commit} — built ${builtAt}` },
  alias: { "server-only": path.join(root, "src/test/server-only-stub.ts") },
  metafile: true,
  logLevel: "warning",
});

const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
if (bytes === 0) throw new Error("The runner Action built empty.");

process.stdout.write(`Built the runner Action for ${commit}: ${bytes} bytes, in ${outDir}\n`);
