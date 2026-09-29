import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { ALREADY_DONE_TRAILER, USAGE_TRAILER, runnerWorkflow } from "./workflow";

/**
 * The loop branch, run the way the job runs it.
 *
 * The generated workflow is the one artifact here that other people execute:
 * shell, long, and writing into someone's repository. Reading it is not enough
 * — twice a defect in it reached a real run (a commit with no git identity, and
 * a summary reading a variable the step's env never set). So this runs it: the
 * script from the generator, the job's own env names, a stubbed loop binary,
 * and real bash, git, jq and curl.
 */

const MISSING = ["bash", "git", "jq", "curl"].filter((cmd) => {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
});

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

const doc = parse(runnerWorkflow()) as { jobs?: { agent?: { steps?: Step[] } } };
const loopStep = (doc.jobs?.agent?.steps ?? []).find((s) => s.name === "Run the agent")!;
/** Every name the workflow gives the step, and nothing else. */
const declared = Object.keys(loopStep.env ?? {});
/** Names a runner provides without the workflow saying so. */
const runnerProvided = ["PATH", "HOME", "RUNNER_TEMP", "GITHUB_WORKSPACE"];
/** Ours, to drive the stub. */
const controls = ["CANNED_REPORT", "CANNED_EXIT", "CANNED_CHANGE"];
/** Next's types require this one on every env object; a runner does not set it. */
const typeOnly = ["NODE_ENV"];

const PAYLOAD = {
  runId: "run_1",
  ticketId: "T-1",
  projectId: "project_default",
  ticket: {
    key: "T-1",
    title: "Allow HTML files as request attachments",
    description: "An HTML file is rejected today.",
    acceptanceCriteria: ["An HTML attachment uploads"],
    fileScope: ["src"],
  },
  repo: { fullName: "acme/widgets", baseBranch: "main" },
  provider: "clinepass",
  model: "cline-pass/glm-5.3",
  limits: { maxDurationMs: 30 * 60_000 },
};

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

const open = new Set<string>();

afterEach(async () => {
  for (const dir of open) await rm(dir, { recursive: true, force: true });
  open.clear();
});


async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "formic-loop-"));
  open.add(dir);
  const repo = path.join(dir, "repo");
  const tmp = path.join(dir, "tmp");
  const bin = path.join(dir, "bin");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(tmp, "attachments"), { recursive: true });
  await mkdir(bin);

  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "someone@example.com");
  git("config", "user.name", "Someone");
  await writeFile(path.join(repo, "src", "page.ts"), "export {};\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  // The loop binary, stubbed: records the payload it was handed, says one
  // thing, prints its report, and exits with what the test asked for.
  const stub = path.join(bin, "node");
  await writeFile(
    stub,
    [
      "#!/usr/bin/env bash",
      'cat > "$RUNNER_TEMP/received-payload.json"',
      'echo \'{"type":"run.progress","runId":"run_1","ticketId":"T-1","role":"coder","label":"Writing src/thing.ts","fraction":0.2}\' >&2',
      'if [ -n "${CANNED_CHANGE:-}" ]; then mkdir -p "$GITHUB_WORKSPACE/src"; echo x > "$GITHUB_WORKSPACE/src/thing.ts"; fi',
      'printf \'%s\\n\' "${CANNED_REPORT}"',
      'exit "${CANNED_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  execFileSync("chmod", ["755", stub]);
  await writeFile(path.join(dir, "loop-entry.mjs"), "export const bundle = true;\n");
  await writeFile(path.join(dir, "run.sh"), loopStep.run!);

  /** The step, with the job's env names and this test's values. */
  const run = (options: {
    report: unknown;
    exitCode?: number;
    change?: boolean;
    apiKey?: string;
  }): Ran => {
    const values: Record<string, string> = {
      CLI: "loop",
      MODE: "loop",
      TICKET: "T-1",
      BUNDLE: `file://${path.join(dir, "loop-entry.mjs")}`,
      MODEL: "cline-pass/glm-5.3",
      PROMPT: JSON.stringify(PAYLOAD),
      // No reporter: the board side of that is tested elsewhere. The stream
      // file the tee writes is what this checks.
      REPORT: "",
      FORMIC_API_KEY: options.apiKey ?? "sk-test-key",
      FORMIC_REPORT: path.join(tmp, "report.json"),
      FORMIC_SUMMARY: path.join(tmp, "summary.md"),
      FORMIC_OUTPUT: path.join(tmp, "answer.md"),
      FORMIC_STDOUT: path.join(tmp, "stdout.md"),
      FORMIC_STREAM: path.join(tmp, "stream.jsonl"),
      FORMIC_NOTES: path.join(tmp, "notes.md"),
      FORMIC_DONE: path.join(tmp, "done"),
      FORMIC_PROGRESS: path.join(tmp, "progress.md"),
      FORMIC_CHECKPOINT: "",
      FORMIC_ATTACHMENTS: path.join(tmp, "attachments"),
      CLAUDE_CODE_ENABLE_TODO_TOOLS: "true",
      CLAUDE_CODE_ENABLE_TASKS: "false",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CODEX_CREDENTIAL: "",
      GEMINI_API_KEY: "",
    };
    // Only names the workflow declares: a value for anything else would mean
    // this test is handing the script something the job never would — which is
    // exactly how a missing TICKET got past the harness this replaced.
    expect(Object.keys(values).filter((k) => !declared.includes(k))).toEqual([]);

    const env: NodeJS.ProcessEnv = {
      ...values,
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: dir,
      RUNNER_TEMP: tmp,
      GITHUB_WORKSPACE: repo,
      NODE_ENV: "test",
      CANNED_REPORT: JSON.stringify(options.report),
      CANNED_EXIT: String(options.exitCode ?? 0),
      ...(options.change ? { CANNED_CHANGE: "1" } : {}),
    };
    expect(
      Object.keys(env).filter(
        (k) =>
          !declared.includes(k) &&
          !runnerProvided.includes(k) &&
          !controls.includes(k) &&
          !typeOnly.includes(k),
      ),
    ).toEqual([]);

    try {
      return {
        status: 0,
        stdout: execFileSync("bash", [path.join(dir, "run.sh")], {
          env,
          cwd: repo,
          encoding: "utf8",
          stdio: "pipe",
        }),
        stderr: "",
      };
    } catch (e) {
      const failed = e as { status?: number; stdout?: string; stderr?: string };
      return { status: failed.status ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  };

  return { dir, repo, tmp, run };
}

describe.skipIf(MISSING.length > 0)("the loop branch, as the job runs it", () => {
  it("hands the loop the key and the checkout, and turns its report into a summary", async () => {
    const { repo, tmp, run } = await fixture();

    const ran = run({
      change: true,
      report: {
        ok: true,
        summary: "Allow HTML attachments",
        detail: "Allowed text/html for request attachments.",
        verifiedWith: "npx vitest run",
        alreadyDone: false,
        handoff: ["Turn on the flag in the service."],
        limit: null,
        usage: { model: "cline-pass/glm-5.3", tokensIn: 900, tokensOut: 300, costCents: 0 },
        changedFiles: ["src/thing.ts"],
        diff: "",
      },
    });

    expect(ran.status, ran.stderr).toBe(0);
    const summary = await readFile(path.join(tmp, "summary.md"), "utf8");
    expect(summary).toContain("T-1: Allow HTML attachments");
    expect(summary).toContain("Allowed text/html for request attachments.");
    expect(summary).toContain("For you:\n- Turn on the flag in the service.");
    expect(summary).toContain(
      `${USAGE_TRAILER} {"model":"cline-pass/glm-5.3","tokensIn":900,"tokensOut":300,"costCents":0}`,
    );
    expect(summary).not.toContain(ALREADY_DONE_TRAILER);

    // The key is injected by the job from the repository's secrets, and the
    // loop works in the job's own checkout rather than a clone of its own.
    // (The path is the shell's own $PWD, which is a real path: `/var` on macOS
    // is a symlink to `/private/var`.)
    const received = JSON.parse(await readFile(path.join(tmp, "received-payload.json"), "utf8"));
    expect(received.apiKey).toBe("sk-test-key");
    expect(received.repo.dir).toBe(realpathSync(repo));
    expect(received.ticket.key).toBe("T-1");

    // Its own words reach the stream the board reads, and the job's log too.
    expect(await readFile(path.join(tmp, "stream.jsonl"), "utf8")).toContain("Writing src/thing.ts");
    // Either stream: a runner's log shows both, and which one the tee writes
    // to is not the point — that it reaches the log at all is.
    expect(`${ran.stdout}${ran.stderr}`).toContain("Writing src/thing.ts");

    // The change is left in the checkout for the commit step that follows.
    const status = execFileSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" });
    expect(status).toContain("src/thing.ts");
  });

  it("marks a ticket already done, and commits nothing but the report", async () => {
    const { repo, tmp, run } = await fixture();
    const count = () =>
      execFileSync("git", ["-C", repo, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
    const before = count();

    const ran = run({
      report: {
        ok: true,
        summary: "Nothing to change",
        detail: "It already does this.",
        verifiedWith: "npx vitest run",
        alreadyDone: true,
        handoff: [],
        limit: null,
        usage: { model: "cline-pass/glm-5.3", tokensIn: 10, tokensOut: 5, costCents: 0 },
        changedFiles: [],
        diff: "",
      },
    });

    expect(ran.status, ran.stderr).toBe(0);
    expect(await readFile(path.join(tmp, "summary.md"), "utf8")).toContain(ALREADY_DONE_TRAILER);
    // An empty commit carrying its own identity: a fresh runner has none, and
    // the step that sets one runs later than this.
    expect(Number(count())).toBe(Number(before) + 1);
    const log = execFileSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toContain("T-1: nothing to change");
  });

  it("stops the job when the loop stops, and says what the loop said", async () => {
    const { tmp, run } = await fixture();

    const ran = run({
      exitCode: 1,
      report: {
        ok: false,
        error: "Ran out of time: this run's budget is 30 minutes.",
        blocked: true,
        limit: "time",
        usage: { model: "cline-pass/glm-5.3", tokensIn: 1, tokensOut: 1, costCents: 0 },
        changedFiles: [],
        diff: "",
      },
    });

    expect(ran.status).not.toBe(0);
    // What the loop said, in its own words, then that the step stopped.
    expect(ran.stderr).toContain("Ran out of time: this run's budget is 30 minutes.");
    expect(ran.stdout).toContain("The loop stopped (exit 1).");
    // Nothing for a commit: a stopped run is a report to the card, not work.
    await expect(readFile(path.join(tmp, "summary.md"), "utf8")).rejects.toThrow();
  });

  it("refuses to start without the agent's key, rather than guessing one", async () => {
    const { tmp, run } = await fixture();

    const ran = run({ apiKey: "", report: { ok: true } });

    expect(ran.status).not.toBe(0);
    expect(ran.stdout).toContain("No API key for this agent");
    // The loop never ran at all.
    await expect(readFile(path.join(tmp, "received-payload.json"), "utf8")).rejects.toThrow();
  });
});

