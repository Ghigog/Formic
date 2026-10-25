import { execFileSync } from "node:child_process";
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
 * script from the generator, the job's own env names, a report like the one the Action leaves,
 * and real bash, git and jq.
 */

const MISSING = ["bash", "git", "jq"].filter((cmd) => {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
});

// Like REQUIRE_TEST_DATABASE: where CI sets REQUIRE_LOOP_TOOLS, a missing tool
// fails the run instead of quietly skipping the suite. Elsewhere it still skips.
if (MISSING.length > 0 && process.env.REQUIRE_LOOP_TOOLS) {
  throw new Error(
    `The loop-branch suite needs ${MISSING.join(", ")} on PATH, and REQUIRE_LOOP_TOOLS is set.`,
  );
}

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

const doc = parse(runnerWorkflow()) as { jobs?: { agent?: { steps?: Step[] } } };
const loopStep = (doc.jobs?.agent?.steps ?? []).find((s) => s.name === "Write the loop's report")!;
/** Every name the workflow gives the step, and nothing else. */
const declared = Object.keys(loopStep.env ?? {});

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
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(tmp, { recursive: true });

  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "someone@example.com");
  git("config", "user.name", "Someone");
  await writeFile(path.join(repo, "src", "page.ts"), "export {};\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  await writeFile(path.join(dir, "run.sh"), loopStep.run!);

  /** The step, with the job's env names and the report the Action left. */
  const run = async (report: unknown): Promise<Ran> => {
    await writeFile(path.join(tmp, "report.json"), `${JSON.stringify(report)}\n`);
    const values: Record<string, string> = {
      TICKET: "T-1",
      FORMIC_REPORT: path.join(tmp, "report.json"),
      FORMIC_SUMMARY: path.join(tmp, "summary.md"),
    };
    // Only names the workflow declares: a value for anything else would mean
    // this test is handing the script something the job never would.
    expect(Object.keys(values).filter((k) => !declared.includes(k))).toEqual([]);

    const env: NodeJS.ProcessEnv = {
      ...values,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      RUNNER_TEMP: tmp,
      GITHUB_WORKSPACE: repo,
      NODE_ENV: "test",
    };

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

describe.skipIf(MISSING.length > 0)("the loop's report step, as the job runs it", () => {
  it("turns the loop's report into a summary", async () => {
    const { tmp, run } = await fixture();

    const ran = await run({
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
  });

  it("marks a ticket already done, and commits nothing but the report", async () => {
    const { repo, tmp, run } = await fixture();
    const count = () =>
      execFileSync("git", ["-C", repo, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
    const before = count();

    const ran = await run({
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
    });

    expect(ran.status, ran.stderr).toBe(0);
    expect(await readFile(path.join(tmp, "summary.md"), "utf8")).toContain(ALREADY_DONE_TRAILER);
    // An empty commit carrying its own identity: a fresh runner has none, and
    // the step that sets one runs later than this.
    expect(Number(count())).toBe(Number(before) + 1);
    const log = execFileSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toContain("T-1: nothing to change");
  });

  describe("the hand-off step, for a CLI agent's stream", () => {
    const handStep = (doc.jobs?.agent?.steps ?? []).find((s) => s.name === "Hand the work to Formic")!;
    const streams: Record<string, { stream: string[]; tokensIn: number; tokensOut: number }> = {
      claude: {
        stream: [
          '{"type":"assistant"}',
          '{"type":"result","result":"done","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":40}}',
        ],
        tokensIn: 115,
        tokensOut: 40,
      },
      codex: {
        stream: [
          '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":150,"output_tokens":20}}',
          '{"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":250,"output_tokens":30}}',
        ],
        tokensIn: 500,
        tokensOut: 50,
      },
      gemini: {
        stream: ['{"type":"result","status":"success","stats":{"input_tokens":70,"output_tokens":8,"total_tokens":78}}'],
        tokensIn: 70,
        tokensOut: 8,
      },
    };

    it.each(Object.keys(streams))("writes a tokens-only usage trailer for %s", async (cli) => {
      const { repo, tmp } = await fixture();
      const { stream, tokensIn, tokensOut } = streams[cli]!;
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
      const start = git("rev-parse", "HEAD").toString().trim();
      await writeFile(path.join(repo, "src", "thing.ts"), "export {};\n");
      await writeFile(path.join(tmp, "stream.jsonl"), `${stream.join("\n")}\n`);
      await writeFile(path.join(tmp, "stdout.md"), "T-1: Did the thing\n");

      // The push has nowhere to go; the summary is written before it.
      try {
        execFileSync("bash", ["-c", handStep.run!], {
          cwd: repo,
          stdio: "pipe",
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: tmp,
            MODE: "implement",
            CLI: cli,
            MODEL: "",
            TICKET: "T-1",
            JOB: "job_1",
            REPO: "acme/widgets",
            GH_TOKEN: "x",
            FORMIC_START: start,
            FORMIC_STREAM: path.join(tmp, "stream.jsonl"),
            FORMIC_SUMMARY: path.join(tmp, "summary.md"),
            FORMIC_OUTPUT: path.join(tmp, "answer.md"),
            FORMIC_STDOUT: path.join(tmp, "stdout.md"),
          },
        });
      } catch {
        // expected: no remote
      }

      const summary = await readFile(path.join(tmp, "summary.md"), "utf8");
      expect(summary).toContain(
        `${USAGE_TRAILER} {"model":"${cli}","tokensIn":${tokensIn},"tokensOut":${tokensOut},"costCents":0}`,
      );
    });
  });
});
