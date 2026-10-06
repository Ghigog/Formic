import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loopBundle, loopEntryHash, setLoopBundleDir } from "./bundle";

/**
 * The loop entry as the job receives it: one file, built from this repository,
 * runnable by plain node with no Next and no database in sight.
 */

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

afterEach(() => setLoopBundleDir(null));

/** Builds the bundle into a directory of its own, the way `npm run build` does. */
async function build(commit = "abcdef1234567890abcdef1234567890abcdef12"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "formic-loop-entry-"));
  execFileSync("node", [path.join(root, "scripts/build-loop-entry.mjs"), dir], {
    cwd: root,
    env: { ...process.env, FORMIC_BUILD_COMMIT: commit },
    stdio: "pipe",
  });
  return dir;
}

const PAYLOAD = {
  runId: "run_1",
  ticket: {
    key: "T-7",
    title: "Add a retry button",
    description: "A failed run has no way back.",
    acceptanceCriteria: ["It can be started again."],
    fileScope: ["src/app"],
  },
  repo: { fullName: "acme/widgets", baseBranch: "main" },
  provider: "deepseek",
  model: "deepseek-chat",
  apiKey: "sk-not-real",
};

describe("the loop entry as a build artifact", () => {
  it("is one file, and records the commit it was built from", async () => {
    const bundle = await loopBundle(await build());

    expect(bundle?.commit).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect(bundle?.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The file names its own commit, so a copy in a job can be identified.
    expect(bundle?.code?.startsWith("// formic loop entry — commit abcdef1234567890abcdef1234567890abcdef12")).toBe(true);
    // `server-only` throws outside a React Server Component: the alias is the
    // whole reason a job can run this at all.
    expect(bundle?.code).not.toContain("server-only");
  });

  it("runs in plain node, and answers in JSON when it cannot", async () => {
    const dir = await build();

    // No checkout handed in and no GitHub credential to clone with: the entry
    // has to say so in its report rather than exit quietly.
    let stdout = "";
    try {
      stdout = execFileSync("node", [path.join(dir, "loop-entry.mjs")], {
        input: JSON.stringify(PAYLOAD),
        encoding: "utf8",
      });
    } catch (e) {
      stdout = String((e as { stdout?: string }).stdout ?? "");
    }

    const report = JSON.parse(stdout) as { ok: boolean; error: string };
    expect(report.ok).toBe(false);
    expect(report.error).toContain("GITHUB_TOKEN");
  });

  it("hashes the code and not the build, so a rebuild is not a new version", async () => {
    const first = await build("1111111111111111111111111111111111111111");
    const second = await build("2222222222222222222222222222222222222222");

    const one = await loopBundle(first);
    const two = await loopBundle(second);
    // The banner records the commit and the time, so the two files differ…
    expect(one?.code).not.toBe(two?.code);
    // …and the hash is of the code alone. The workflow's version is hashed over
    // it, so two builds of one source are one version, and no repository is
    // asked to update itself because a board was deployed again.
    expect(one?.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(one?.hash).toBe(two?.hash);
    // The board reads only the sidecar for that version: it is checked on every
    // board read, and must not pull three quarters of a megabyte to do it.
    expect(await loopEntryHash(first)).toBe(one?.hash);
  });

  it("is nothing at all when a build did not produce one", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "formic-no-bundle-"));
    expect(await loopBundle(empty)).toBeNull();

    // A file with no code in it is not a bundle either: a job must never be
    // handed something it would run to no effect.
    const blank = await mkdtemp(path.join(tmpdir(), "formic-blank-bundle-"));
    await writeFile(path.join(blank, "loop-entry.mjs"), "\n");
    await writeFile(path.join(blank, "loop-entry.json"), JSON.stringify({ commit: "abc", builtAt: "" }));
    expect(await loopBundle(blank)).toBeNull();
  });
});
