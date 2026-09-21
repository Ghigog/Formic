import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalSandboxProvider, shellQuote } from "./local";
import type { SandboxHandle } from "./types";
import { violationsInDiff } from "@/lib/domain/scope";

const run = promisify(execFile);

/**
 * Exercises the provider against a real git repository on disk: clone, exec,
 * stream, diff, scope enforcement and disposal.
 */

let originDir: string;
let sandbox: SandboxHandle | null = null;

beforeAll(async () => {
  originDir = await mkdtemp(path.join(tmpdir(), "formic-origin-"));

  const git = (args: string[]) => run("git", args, { cwd: originDir });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Formic Test"]);

  await writeFile(path.join(originDir, "README.md"), "# fixture\n");
  await run("mkdir", ["-p", path.join(originDir, "src")]);
  await writeFile(path.join(originDir, "src", "index.js"), "export const x = 1;\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "initial"]);
}, 60_000);

afterAll(async () => {
  await sandbox?.dispose();
});

describe("LocalSandboxProvider", () => {
  it("clones a repository and reports ready", async () => {
    sandbox = await new LocalSandboxProvider().spawn({
      repoFullName: "fixture/repo",
      cloneUrl: originDir,
      baseBranch: "main",
      branchName: "formic/test-run",
    });

    expect(sandbox.state()).toBe("ready");
    expect(await sandbox.readFile("README.md")).toContain("# fixture");
  }, 60_000);

  it("checks out the requested branch", async () => {
    const result = await sandbox!.exec("git rev-parse --abbrev-ref HEAD");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("formic/test-run");
  });

  it("streams stdout line by line", async () => {
    const lines: string[] = [];
    const result = await sandbox!.exec("printf 'one\\ntwo\\nthree\\n'", {
      onStdout: (l) => lines.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("separates stderr and reports a non-zero exit", async () => {
    const errors: string[] = [];
    const result = await sandbox!.exec("echo bad 1>&2; exit 3", {
      onStderr: (l) => errors.push(l),
    });
    expect(result.exitCode).toBe(3);
    expect(errors).toEqual(["bad"]);
  });

  it("reports edits and additions as changed files", async () => {
    await sandbox!.exec("echo 'export const y = 2;' >> src/index.js");
    await sandbox!.exec("mkdir -p src/extra && echo 'new' > src/extra/new.txt");

    const changed = await sandbox!.changedFiles();
    expect(changed).toContain("src/index.js");
    expect(changed).toContain("src/extra/new.txt");
  }, 30_000);

  it("catches a diff that strays outside the declared file scope", async () => {
    await sandbox!.exec("echo 'touched' >> README.md");
    const changed = await sandbox!.changedFiles();

    // This is the check the Coder Agent runs before committing.
    expect(violationsInDiff(changed, ["src"])).toContain("README.md");
    expect(violationsInDiff(changed, ["src", "README.md"])).toEqual([]);
  }, 30_000);

  it("refuses to read outside the sandbox directory", async () => {
    await expect(sandbox!.readFile("../../etc/passwd")).rejects.toThrow(
      /outside the sandbox/,
    );
  });

  it("stops a command that exceeds its timeout", async () => {
    const result = await sandbox!.exec("sleep 10", { timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
  }, 30_000);

  it("stops a command when its signal aborts", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await sandbox!.exec("sleep 10", { signal: controller.signal });
    expect(result.timedOut).toBe(true);
  }, 30_000);

  it("disposes, and refuses to run afterwards", async () => {
    await sandbox!.dispose();
    expect(sandbox!.state()).toBe("disposed");
    await expect(sandbox!.exec("echo hi")).rejects.toThrow(/disposed/);
    sandbox = null;
  }, 30_000);

  it("disposes itself when its TTL expires", async () => {
    const shortLived = await new LocalSandboxProvider().spawn({
      repoFullName: "fixture/repo",
      cloneUrl: originDir,
      baseBranch: "main",
      ttlMs: 500,
    });
    expect(shortLived.state()).toBe("ready");
    await new Promise((r) => setTimeout(r, 1200));
    expect(shortLived.state()).toBe("disposed");
  }, 60_000);
});

describe("shellQuote", () => {
  it("survives an embedded single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("neutralises a command substitution attempt", () => {
    expect(shellQuote("$(rm -rf /)")).toBe(`'$(rm -rf /)'`);
  });
});
