import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { gitlabRunnerConfig } from "./gitlab-ci-config";
import { runnerWorkflow, SESSION_RESTORE_SCRIPT, SESSION_SAVE_SCRIPT, workflowTakesSession } from "./workflow";

/**
 * The PM session's part of the installed workflow (docs/plans/pm-chat.md,
 * PR 3, safety row 10). Merging a change to the workflow deploys it and
 * Formic then replaces it in every connected repository, so it must be
 * additive only: an old run, one with no `session`, behaves exactly as it did.
 */

interface Step {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}

const doc = parse(runnerWorkflow()) as {
  on: { workflow_dispatch: { inputs: Record<string, { required?: boolean; default?: string }> } };
  jobs: { agent: { steps: Step[] } };
};
const steps = doc.jobs.agent.steps;
const step = (name: string) => steps.find((s) => s.name === name)!;

/** A directory with fake `claude` and `curl` on the PATH, and a checkout in it. */
function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "formic-session-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const temp = path.join(root, "temp");
  const work = path.join(root, "work", "repo");
  for (const d of [bin, home, temp, work]) mkdirSync(d, { recursive: true });
  execSync("git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init", { cwd: work });
  return { root, bin, home, temp, work };
}

describe("the workflow's PM session", () => {
  it("takes the session as an optional input, empty by default, so an old dispatch is still valid", () => {
    const input = doc.on.workflow_dispatch.inputs.session!;
    expect(input.required).toBe(false);
    expect(input.default).toBe("");
    expect(workflowTakesSession(runnerWorkflow())).toBe(true);
    expect(workflowTakesSession("name: Formic agent\non: workflow_dispatch")).toBe(false);
    expect(workflowTakesSession(null)).toBe(false);
  });

  it("runs its steps only for a session, and never fails a run by saving one", () => {
    expect(step("Restore the PM's session").if).toBe("inputs.session != '' && inputs.cli == 'claude'");
    const save = step("Save the PM's session");
    expect(save.if).toBe("always() && inputs.session != '' && inputs.cli == 'claude'");
    expect(save["continue-on-error"]).toBe(true);
    // The token that fetches the branches is the step's own, never the agent's.
    expect(step("Run the agent").env?.GH_TOKEN).toBeUndefined();
    expect(step("Restore the PM's session").env?.GH_TOKEN).toBe("${{ github.token }}");
  });

  function runAgent(env: Record<string, string>) {
    const box = sandbox();
    const argsFile = path.join(box.root, "args");
    writeFileSync(
      path.join(box.bin, "claude"),
      `#!/bin/bash\nprintf '%s\\n' "$@" > "${argsFile}"\necho '{"type":"result","result":"hi","session_id":"s-1"}'\n`,
    );
    chmodSync(path.join(box.bin, "claude"), 0o755);
    const run = step("Run the agent").run!;
    const ran = spawnSync("bash", ["-c", run], {
      cwd: box.work,
      encoding: "utf8",
      env: {
        NODE_ENV: "test" as const, PATH: `${box.bin}:${process.env.PATH}`,
        HOME: box.home,
        RUNNER_TEMP: box.temp,
        CLI: "claude",
        MODEL: "",
        PROMPT: "Hello",
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
        FORMIC_STREAM: path.join(box.temp, "stream.jsonl"),
        FORMIC_STDOUT: path.join(box.temp, "stdout.md"),
        ...env,
      },
    });
    expect(ran.status, ran.stderr).toBe(0);
    return readFileSync(argsFile, "utf8").trim().split("\n");
  }

  it("runs Claude Code exactly as before when there is no session", () => {
    const args = runAgent({});
    expect(args).toEqual([
      "-p",
      "Hello",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      expect.stringContaining("formic-hooks.json"),
      "--dangerously-skip-permissions",
    ]);
  });

  it("starts a new session by its id, or resumes a saved one, with Formic's MCP server", () => {
    expect(runAgent({ FORMIC_SESSION_ID: "s-1", FORMIC_MCP_CONFIG: "/tmp/mcp.json" }).slice(-4)).toEqual([
      "--session-id",
      "s-1",
      "--mcp-config",
      "/tmp/mcp.json",
    ]);
    expect(
      runAgent({ FORMIC_SESSION_ID: "s-1", FORMIC_SESSION_RESUME: "1", FORMIC_MCP_CONFIG: "/tmp/mcp.json" }).slice(-4),
    ).toEqual(["--resume", "s-1", "--mcp-config", "/tmp/mcp.json"]);
  });

  it("puts the saved session where claude --resume finds it, writes the MCP config, and hands the session back", () => {
    const box = sandbox();
    const jsonl = '{"type":"user","message":"hello"}\n';
    const packed = execSync("gzip -c | base64 -w0", { input: jsonl }).toString();
    const served = path.join(box.root, "served.json");
    writeFileSync(served, JSON.stringify({ sessionId: "s-9", file: packed, mcp: { url: "https://f.example/api/mcp", token: "fmc_x" } }));
    const posted = path.join(box.root, "posted.json");
    // A fake curl: GET serves the handoff, POST keeps the body it was sent.
    writeFileSync(
      path.join(box.bin, "curl"),
      `#!/bin/bash\nout=""; data=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; --data-binary) data="\${2#@}"; shift;; esac; shift; done\nif [ -n "$data" ]; then cp "$data" "${posted}"; else cp "${served}" "$out"; fi\n`,
    );
    chmodSync(path.join(box.bin, "curl"), 0o755);
    const envFile = path.join(box.temp, "env");
    const env = { NODE_ENV: "test" as const, PATH: `${box.bin}:${process.env.PATH}`, HOME: box.home, RUNNER_TEMP: box.temp, SESSION: "https://f.example/s", FORMIC_ENV_OUT: envFile };

    const restored = spawnSync("bash", ["-c", SESSION_RESTORE_SCRIPT], { cwd: box.work, env, encoding: "utf8" });
    expect(restored.status, restored.stderr).toBe(0);
    const dir = path.join(box.home, ".claude", "projects", box.work.replace(/[^A-Za-z0-9]/g, "-"));
    expect(readFileSync(path.join(dir, "s-9.jsonl"), "utf8")).toBe(jsonl);
    expect(readFileSync(envFile, "utf8")).toContain("FORMIC_SESSION_RESUME=1");
    expect(readFileSync(envFile, "utf8")).toContain("FORMIC_SESSION_ID=s-9");
    const mcp = JSON.parse(readFileSync(path.join(box.temp, "formic-mcp.json"), "utf8"));
    expect(mcp).toEqual({ mcpServers: { formic: { type: "http", url: "https://f.example/api/mcp", headers: { Authorization: "Bearer fmc_x" } } } });
    // The handoff, token and all, does not stay on the runner.
    expect(existsSync(path.join(box.temp, "formic-session.json"))).toBe(false);

    // The session went on; the checkout is on the PM's branch.
    writeFileSync(path.join(dir, "s-9.jsonl"), `${jsonl}{"type":"assistant"}\n`);
    execSync("git checkout -q -b formic-pm/fix", { cwd: box.work });
    const stream = path.join(box.temp, "stream.jsonl");
    writeFileSync(stream, '{"type":"result","result":"done","session_id":"s-9"}\n');
    const saved = spawnSync("bash", ["-c", SESSION_SAVE_SCRIPT], { cwd: box.work, env: { ...env, FORMIC_STREAM: stream }, encoding: "utf8" });
    expect(saved.status, saved.stderr).toBe(0);
    const body = JSON.parse(readFileSync(posted, "utf8"));
    expect(body.sessionId).toBe("s-9");
    expect(body.branch).toBe("formic-pm/fix");
    expect(gunzipSync(Buffer.from(body.file, "base64")).toString()).toBe(`${jsonl}{"type":"assistant"}\n`);
  });

  it("starts fresh when Formic has no file for it yet", () => {
    const box = sandbox();
    writeFileSync(path.join(box.root, "served.json"), JSON.stringify({ sessionId: "s-new", file: "", mcp: { url: "u", token: "t" } }));
    writeFileSync(path.join(box.bin, "curl"), `#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && cp "${path.join(box.root, "served.json")}" "$2"; shift; done\n`);
    chmodSync(path.join(box.bin, "curl"), 0o755);
    const envFile = path.join(box.temp, "env");
    const ran = spawnSync("bash", ["-c", SESSION_RESTORE_SCRIPT], {
      cwd: box.work,
      env: { NODE_ENV: "test" as const, PATH: `${box.bin}:${process.env.PATH}`, HOME: box.home, RUNNER_TEMP: box.temp, SESSION: "s", FORMIC_ENV_OUT: envFile },
      encoding: "utf8",
    });
    expect(ran.status, ran.stderr).toBe(0);
    expect(readFileSync(envFile, "utf8")).not.toContain("FORMIC_SESSION_RESUME");
    expect(readFileSync(envFile, "utf8")).toContain("FORMIC_SESSION_ID=s-new");
  });

  it("keeps a failed save from failing anything", () => {
    const box = sandbox();
    writeFileSync(path.join(box.bin, "curl"), "#!/bin/bash\nexit 22\n");
    chmodSync(path.join(box.bin, "curl"), 0o755);
    const ran = spawnSync("bash", ["-c", SESSION_SAVE_SCRIPT], {
      cwd: box.work,
      env: { NODE_ENV: "test" as const, PATH: `${box.bin}:${process.env.PATH}`, HOME: box.home, RUNNER_TEMP: box.temp, SESSION: "s", FORMIC_STREAM: "/nope" },
      encoding: "utf8",
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("next turn starts from Formic's summary");
  });

  it("gives the GitLab job the same session, only when it is asked for", () => {
    const config = gitlabRunnerConfig();
    expect(config).toContain('if [ -n "${FORMIC_SESSION:-}" ]; then');
    expect(config).toContain("--mcp-config");
    // The run without a session keeps its one claude line as it was.
    expect(config).toContain(
      'CLAUDE_CODE_OAUTH_TOKEN="$SECRET_VALUE" timeout "${MINUTES}m" claude "${args[@]}" | tee -a "$FORMIC_STREAM"\n',
    );
    // A session can never be named as the agent's secret.
    expect(config).toContain("|FORMIC_SESSION)");
  });

  /** The hand-off step, run in a checkout whose agent committed its own work, pushing to a local remote. */
  function handOff(session: boolean) {
    const box = sandbox();
    const remote = path.join(box.root, "remote.git");
    execSync(`git init -q --bare ${remote}`);
    const start = execSync("git rev-parse HEAD", { cwd: box.work }).toString().trim();
    writeFileSync(path.join(box.work, "fix.txt"), "fixed\n");
    execSync("git add fix.txt && git -c user.name=pm -c user.email=pm@x commit -q -m 'Fix the thing'", { cwd: box.work });
    const answer = path.join(box.temp, "answer.md");
    writeFileSync(answer, "Done.");
    const ran = spawnSync("bash", ["-c", step("Hand the work to Formic").run!], {
      cwd: box.work,
      encoding: "utf8",
      env: {
        NODE_ENV: "test" as const,
        PATH: process.env.PATH,
        HOME: box.home,
        RUNNER_TEMP: box.temp,
        JOB: "m1--abc",
        MODE: "ask",
        TICKET: "assistant",
        FORMIC_START: start,
        FORMIC_OUTPUT: answer,
        FORMIC_STDOUT: answer,
        FORMIC_SUMMARY: path.join(box.temp, "summary.md"),
        GH_TOKEN: "t",
        REPO: "o/r",
        ...(session ? { FORMIC_SESSION_ID: "s-1" } : {}),
        // github.com, as the step names it, is the local remote here.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
        GIT_CONFIG_VALUE_0: "https://x-access-token:t@github.com/o/r.git",
      },
    });
    expect(ran.status, ran.stderr + ran.stdout).toBe(0);
    const branches = execSync("git branch --list", { cwd: remote }).toString();
    return { branches, remote };
  }

  it("keeps the commits a PM session made itself, beside its answer", () => {
    const { branches, remote } = handOff(true);
    expect(branches).toContain("formic-staging/m1--abc-change");
    expect(execSync("git log -1 --format=%s formic-staging/m1--abc-change", { cwd: remote }).toString().trim()).toBe("Fix the thing");
    expect(branches).toContain("formic-staging/m1--abc\n");
  });

  it("hands back only the answer, as before, for an old run whose agent committed", () => {
    const { branches } = handOff(false);
    expect(branches).not.toContain("-change");
    expect(branches).toContain("formic-staging/m1--abc");
  });
});
