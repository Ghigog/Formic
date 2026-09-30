import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ALREADY_DONE_TRAILER,
  RUNNER_WORKFLOW_PATH,
  RUNNER_JOB_MINUTES,
  RUNNER_VERSION,
  USAGE_TRAILER,
  parseRunTitle,
  runTitle,
  runnerWorkflow,
} from "./workflow";

/**
 * The variables a shell will really read from a script: not the ones inside a
 * single-quoted string (a jq program reads its own `$key`), not the ones in a
 * comment (Formic's prose is full of them), and not the ones in a quoted
 * heredoc (the Python reporter). A small state machine, because these rules are
 * a shell's — guessing at them with regexes gets an apostrophe in a comment
 * wrong, and then reports a variable that does not exist.
 */
function shellReads(script: string): Set<string> {
  const found = new Set<string>();
  let heredoc: string | null = null;

  for (const line of script.split("\n")) {
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    let inDouble = false;
    for (let i = 0; i < line.length; ) {
      const rest = line.slice(i);
      const ch = line[i]!;

      if (heredoc) break;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'" && !inDouble) {
        const end = line.indexOf("'", i + 1);
        i = end === -1 ? line.length : end + 1;
        continue;
      }
      if (ch === '"') {
        inDouble = !inDouble;
        i += 1;
        continue;
      }
      if (ch === "#" && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) break;
      if (ch === "<" && line[i + 1] === "<") {
        const m = /^<<-?'?([A-Za-z_][A-Za-z0-9_]*)'?/.exec(rest);
        if (m) heredoc = m[1]!;
        i += 2;
        continue;
      }
      if (ch === "$") {
        const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(rest);
        if (m) {
          found.add(m[1]!);
          i += m[0].length;
          continue;
        }
      }
      i += 1;
    }
  }
  return found;
}

/**
 * The workflow Formic installs in someone else's repository, checked the way
 * such a file must be: it has to parse as YAML (GitHub refuses what does not),
 * every script it runs has to parse as bash, every variable those scripts read
 * has to be set somewhere, and the copy this repository has checked in has to
 * be what the generator just produced.
 */

const text = runnerWorkflow();

interface Step {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}

const doc = parse(text) as {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  jobs?: { agent?: { "timeout-minutes"?: number; steps?: Step[] } };
};

const steps = doc.jobs?.agent?.steps ?? [];
const step = (name: string): Step => {
  const found = steps.find((s) => s.name === name);
  expect(found, `no step named ${name}`).toBeTruthy();
  return found!;
};

describe("the installed workflow", () => {
  it("gives the job 180 minutes, the ceiling loop runs are clamped to", () => {
    expect(RUNNER_JOB_MINUTES).toBe(180);
    expect(doc.jobs?.agent?.["timeout-minutes"]).toBe(RUNNER_JOB_MINUTES);
  });

  it("parses as the YAML a runner will accept", () => {
    expect(() => parse(text)).not.toThrow();
    expect(text.startsWith(`# ${RUNNER_VERSION}`)).toBe(true);
    expect(Object.keys(doc.on?.workflow_dispatch?.inputs ?? {})).toEqual(
      expect.arrayContaining(["job", "mode", "ticket", "cli", "model", "from", "secret", "prompt", "bundle", "report", "merge"]),
    );
  });

  it("has every script in it parse as bash", () => {
    for (const s of steps.filter((x) => x.run)) {
      expect(
        () => execFileSync("bash", ["-n"], { input: s.run!, stdio: "pipe" }),
        `${s.name ?? "(unnamed step)"}`,
      ).not.toThrow();
    }
  });

  it("carries mode loop: fetch the entry, run it, hand its report back", () => {
    const run = step("Run the agent");
    expect(run.if).toBeUndefined();
    expect(run.env?.MODE).toBe("${{ inputs.mode }}");
    expect(run.env?.FORMIC_API_KEY).toContain("FORMIC_API_KEY_");
    expect(run.run).toContain('case "$MODE" in');
    expect(run.run).toContain("formic-loop.mjs");
    // The checkout it works in is the job's own, not a clone of its own.
    expect(run.run).toContain(".repo.dir = $dir");
    // What the ticket gets from the run's report.
    expect(run.run).toContain(USAGE_TRAILER);
    expect(run.run).toContain(ALREADY_DONE_TRAILER);
    // A loop run needs the repository's dependencies, but no CLI agent.
    expect(step("Install the project's dependencies").if).toContain("inputs.mode == 'loop'");
    expect(step("Install the agent").if).toBe("inputs.mode != 'loop'");
  });

  it("gives every script in it the variables that script reads", () => {
    // What a runner sets for any step, without the workflow saying so.
    const runnerProvided = new Set([
      "PATH", "HOME", "PWD", "SHELL", "USER", "TMPDIR", "CI", "LANG",
      "RUNNER_TEMP", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_NAME",
      "GITHUB_WORKSPACE", "GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH",
      "GITHUB_TOKEN", "GITHUB_SHA", "GITHUB_REF", "GITHUB_REF_NAME", "GITHUB_HEAD_REF",
      "GITHUB_REPOSITORY", "GITHUB_REPOSITORY_OWNER", "GITHUB_RUN_ID", "GITHUB_RUN_NUMBER",
      "GITHUB_JOB", "GITHUB_ACTOR", "GITHUB_EVENT_NAME", "GITHUB_SERVER_URL",
      // Bash's own, which no workflow has to declare.
      "PIPESTATUS", "BASH_REMATCH", "SECONDS", "RANDOM", "LINENO", "FUNCNAME",
      "IFS", "OSTYPE", "HOSTNAME", "SHLVL", "OLDPWD",
    ]);

    // What one step hands the next: a step that writes to $GITHUB_ENV is how
    // GitHub makes a variable available to everything after it.
    const throughGithubEnv = new Set<string>();
    for (const s of steps.filter((x) => x.run?.includes("GITHUB_ENV"))) {
      for (const m of s.run!.matchAll(/(?:^|[\s;("])([A-Za-z_][A-Za-z0-9_]*)=/gm)) {
        throughGithubEnv.add(m[1]!);
      }
    }

    for (const s of steps.filter((x) => x.run)) {
      const script = s.run!;
      const env = new Set(Object.keys(s.env ?? {}));
      // Set inside the script itself: an assignment, a loop's variable, or
      // whatever `read` filled.
      const assigned = new Set(
        [...script.matchAll(/(?:^|[\s;(])([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]!),
      );
      for (const m of script.matchAll(/\bfor ([A-Za-z_][A-Za-z0-9_]*) in\b/g)) assigned.add(m[1]!);
      for (const m of script.matchAll(/\bread(?: -\w+)* ([A-Za-z_][A-Za-z0-9_]*)/g)) {
        assigned.add(m[1]!);
      }

      const missing = [...shellReads(script)].filter(
        (name) =>
          !env.has(name) &&
          !assigned.has(name) &&
          !throughGithubEnv.has(name) &&
          !runnerProvided.has(name),
      );
      // The failure this catches is real and cost a run: a summary block read
      // `$TICKET` in a step whose env never set it, so `set -u` killed the job
      // one line before it committed the work.
      expect(missing, `${s.name ?? "a step"} reads ${missing.join(", ")}: nothing sets it`).toEqual([]);
    }
  });

  it("is what this repository has checked in, refreshed by the generator alone", () => {
    const root = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(readFileSync(path.join(root, RUNNER_WORKFLOW_PATH), "utf8")).toBe(text);
  });

  it("puts loop runs in a title its completion can read back", () => {
    expect(parseRunTitle(runTitle("loop", "T-7", "card--abc"))).toEqual({
      mode: "loop",
      ticketKey: "T-7",
      job: "card--abc",
    });
    // The other modes keep parsing exactly as they did.
    expect(parseRunTitle(runTitle("implement", "T-1", "card--def"))?.mode).toBe("implement");
    expect(parseRunTitle("Formic deploy T-1 · card--ghi")).toBeNull();
  });
});
