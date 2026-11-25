import "server-only";

import { gunzipSync, gzipSync } from "node:zlib";

import { cloneUrl } from "@/lib/coder/checkout";
import { repository } from "@/lib/db";
import { readStreamLine, type StreamItem } from "@/lib/runner/stream";
import { ASSISTANT_CHANGE_SUFFIX, RUNNER_JOB_MINUTES } from "@/lib/runner/workflow";
import { STAGING_PREFIX } from "@/lib/vcs/types";
import { shellQuote } from "@/lib/sandbox/local";
import { redact } from "@/lib/secrets/redact";
import { pmSandboxes, type PmCommand, type PmSandbox } from "./sandbox";
import type { PackedFile } from "./store";

/**
 * One PM turn in its E2B sandbox (docs/plans/pm-chat.md, PR 3b): the same
 * session the repository's CI would run, but kept warm. The sandbox is
 * resumed (ladder step 1), or made again from the saved session file when it
 * is gone (step 2); a sandbox that cannot be had at all sends the turn to CI
 * (step 3). The session file in the database stays the truth: the sandbox is
 * a cache.
 *
 * Formic drives the sandbox itself, so nothing is collected over the
 * internet: the session file is written in, the PM's words stream out as
 * Claude Code prints them, and the file comes back when it ends. As in CI,
 * the PM cannot push: the repository token is only on the command line of a
 * fetch or a push Formic runs between turns, never in the checkout's config
 * or the agent's environment. Its commits go to the turn's staging branch and
 * landPmChange moves them under the branch rules.
 */

/** Where the checkout lives in the sandbox. */
export const PM_REPO_DIR = "/home/user/repo";
/** Where Claude Code keeps the checkout's sessions: its project directory, named after the path. */
export const PM_SESSIONS_DIR = `/home/user/.claude/projects/${PM_REPO_DIR.replace(/[^A-Za-z0-9]/g, "-")}`;
const PROMPT_PATH = "/tmp/formic-prompt.txt";
const MCP_PATH = "/tmp/formic-mcp.json";

/** How long the sandbox may run one turn: the CI job's ceiling. */
export const PM_TURN_MS = RUNNER_JOB_MINUTES * 60 * 1000;
/** How long it stays up after a turn before E2B pauses it, if Formic's own pause never lands. */
const IDLE_MS = 5 * 60 * 1000;
const SETUP_MS = 6 * 60 * 1000;

export interface E2bTurnInput {
  projectId: string;
  messageId: string;
  job: string;
  prompt: string;
  sessionId: string;
  /** The saved session file, when this turn resumes one. */
  file: PackedFile | null;
  sandboxId: string | null;
  e2bKey: string;
  claudeToken: string;
  model: string | null;
  /** The turn's limits: Claude Code's steps, and how long it may run. */
  maxTurns: number;
  timeoutMs: number;
  mcp: { url: string; token: string };
  repoFullName: string;
  repoToken: string;
  baseBranch: string;
  /** The session's words as Claude Code prints them. */
  onItems: (items: StreamItem[]) => Promise<void>;
  /** The raw lines, for what the turn used. */
  onLines?: (lines: string[]) => Promise<void>;
}

export interface E2bTurnResult {
  sandboxId: string;
  reply: string | null;
  failure: string | null;
  /** The session id Claude Code reported, and the file it left. */
  sessionId: string;
  file: PackedFile;
  branch: string;
  /** The head of the turn's staging branch, when the PM committed something. */
  changeSha: string | null;
}

/** The sandbox could not be had at all: the turn goes to CI instead. */
export class SandboxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailable";
  }
}

declare global {
  var __formicPmCommands: Map<string, PmCommand> | undefined;
}

/** The Claude Code command each running turn is, by job: what Stop kills. */
function running(): Map<string, PmCommand> {
  return (globalThis.__formicPmCommands ??= new Map());
}

/** Stops a turn running in its sandbox; false when none is, in this process. */
export async function killE2bTurn(job: string): Promise<boolean> {
  const command = running().get(job);
  if (!command) return false;
  running().delete(job);
  await command.kill();
  return true;
}

function failure(step: string, r: { stdout: string; stderr: string }): string {
  const said = redact(`${r.stderr}\n${r.stdout}`).trim().split("\n").slice(-6).join("\n");
  return said ? `${step}:\n${said}` : step;
}

/** A sandbox made from nothing: Claude Code installed and the repository cloned, without a token left behind. */
async function prepare(sandbox: PmSandbox, input: E2bTurnInput): Promise<void> {
  const install = await sandbox.run(
    "command -v claude >/dev/null || sudo npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code",
    { timeoutMs: SETUP_MS },
  );
  if (install.exitCode !== 0) throw new SandboxUnavailable(failure("Could not install Claude Code in the PM's sandbox", install));
  const url = cloneUrl(input.repoFullName, input.repoToken);
  const plain = url.replace(/\/\/[^@/]*@/, "//");
  const clone = await sandbox.run(
    [
      `git clone --quiet --depth 50 --branch ${shellQuote(input.baseBranch)} ${shellQuote(url)} ${PM_REPO_DIR}`,
      `cd ${PM_REPO_DIR}`,
      `git remote set-url origin ${shellQuote(plain)}`,
      `git config user.name "Formic PM"`,
      `git config user.email formic-agent@users.noreply.github.com`,
    ].join(" && "),
    { timeoutMs: SETUP_MS },
  );
  if (clone.exitCode !== 0) throw new SandboxUnavailable(failure(`Could not clone ${input.repoFullName} into the PM's sandbox`, clone));
}

/** The sandbox, resumed, or made again when it is gone. */
async function sandboxFor(input: E2bTurnInput): Promise<PmSandbox> {
  const sandboxes = pmSandboxes();
  if (input.sandboxId) {
    try {
      return await sandboxes.connect(input.sandboxId, input.e2bKey, PM_TURN_MS);
    } catch {
      // Gone (E2B's retention, or killed): made again below, from the saved file.
    }
  }
  let sandbox: PmSandbox;
  try {
    sandbox = await sandboxes.create(input.e2bKey, PM_TURN_MS);
  } catch (e) {
    throw new SandboxUnavailable(`Could not start the PM's E2B sandbox: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await prepare(sandbox, input);
  } catch (e) {
    await sandbox.kill();
    throw e;
  }
  return sandbox;
}

/** The last `result` event of Claude Code's stream: its reply, whether it failed, and its session id. */
export function resultOf(stream: string): { reply: string | null; isError: boolean; sessionId: string | null } {
  let found: { reply: string | null; isError: boolean; sessionId: string | null } = { reply: null, isError: false, sessionId: null };
  for (const line of stream.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const event = JSON.parse(t) as { type?: unknown; result?: unknown; is_error?: unknown; session_id?: unknown };
      if (event.type !== "result") continue;
      found = {
        reply: typeof event.result === "string" ? event.result : null,
        isError: event.is_error === true,
        sessionId: typeof event.session_id === "string" ? event.session_id : null,
      };
    } catch {
      // Not an event.
    }
  }
  return found;
}

/**
 * Runs the turn. Throws SandboxUnavailable when no sandbox could be had (the
 * caller sends the turn to CI); every other failure is in the result, with
 * the sandbox paused for the next turn.
 */
export async function runE2bTurn(input: E2bTurnInput): Promise<E2bTurnResult> {
  const sandbox = await sandboxFor(input);
  const git = (args: string) => `cd ${PM_REPO_DIR} && git ${args}`;
  const authed = cloneUrl(input.repoFullName, input.repoToken);
  const sessionPath = (id: string) => `${PM_SESSIONS_DIR}/${id}.jsonl`;

  try {
    await sandbox.keepFor(PM_TURN_MS);

    // Every turn starts from the base branch, as a CI job does, with every
    // branch there to check out: a ticket's branch is where a fix goes.
    const fetched = await sandbox.run(
      [
        git(`fetch --quiet --no-tags ${shellQuote(authed)} '+refs/heads/*:refs/remotes/origin/*'`),
        git("reset --quiet --hard"),
        git("clean -fdq"),
        git(`checkout --quiet --detach ${shellQuote(`origin/${input.baseBranch}`)}`),
      ].join(" && "),
      { timeoutMs: SETUP_MS },
    );
    if (fetched.exitCode !== 0) {
      return await ended(sandbox, input, { failure: failure("Could not bring the PM's checkout up to date", fetched) });
    }
    const start = (await sandbox.run(git("rev-parse HEAD"))).stdout.trim();

    // The saved file is the truth, whatever the sandbox kept.
    if (input.file) {
      await sandbox.run(`mkdir -p ${shellQuote(PM_SESSIONS_DIR)}`);
      await sandbox.write(sessionPath(input.sessionId), gunzipSync(Buffer.from(input.file, "base64")).toString("utf8"));
    }
    await sandbox.write(PROMPT_PATH, input.prompt);
    await sandbox.write(
      MCP_PATH,
      JSON.stringify({ mcpServers: { formic: { type: "http", url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.token}` } } } }),
    );

    const args = [
      `-p "$(cat ${PROMPT_PATH})"`,
      "--output-format stream-json --verbose --dangerously-skip-permissions",
      input.file ? `--resume ${shellQuote(input.sessionId)}` : `--session-id ${shellQuote(input.sessionId)}`,
      `--mcp-config ${MCP_PATH}`,
      input.model ? `--model ${shellQuote(input.model)}` : "",
      `--max-turns ${input.maxTurns}`,
    ].filter(Boolean);

    let stream = "";
    let partial = "";
    let pending = Promise.resolve();
    const onStdout = (data: string) => {
      stream += data;
      const lines = (partial + data).split("\n");
      partial = lines.pop() ?? "";
      const items = lines.flatMap(readStreamLine).filter((i) => i.kind !== "log");
      if (items.length) pending = pending.then(() => input.onItems(items)).catch(() => undefined);
      if (input.onLines && lines.length) pending = pending.then(() => input.onLines!(lines)).catch(() => undefined);
    };
    const command = await sandbox.start(`cd ${PM_REPO_DIR} && claude ${args.join(" ")}`, {
      envs: { CLAUDE_CODE_OAUTH_TOKEN: input.claudeToken },
      timeoutMs: Math.min(input.timeoutMs, PM_TURN_MS),
      onStdout,
    });
    running().set(input.job, command);
    const done = await command.wait();
    const stopped = !running().has(input.job);
    running().delete(input.job);
    if (partial) onStdout("\n");
    await pending;
    await sandbox.run(`rm -f ${PROMPT_PATH} ${MCP_PATH}`);

    const result = resultOf(stream || done.stdout);
    const sessionId = result.sessionId ?? input.sessionId;

    // What the PM left uncommitted is kept too, never a workflow; then its
    // commits go to the turn's staging branch for Formic to land.
    await sandbox.run(
      [
        git("add -A"),
        git("reset -q -- .github/workflows"),
        `(${git("diff --cached --quiet")} || ${git(`commit -q -m "Changes from the board's PM"`)})`,
      ].join(" && "),
    );
    const head = (await sandbox.run(git("rev-parse HEAD"))).stdout.trim();
    let changeSha: string | null = null;
    if (!stopped && head && head !== start) {
      const staging = `${STAGING_PREFIX}${input.job}${ASSISTANT_CHANGE_SUFFIX}`;
      const pushed = await sandbox.run(git(`push --quiet ${shellQuote(authed)} ${shellQuote(`HEAD:refs/heads/${staging}`)}`), { timeoutMs: SETUP_MS });
      if (pushed.exitCode === 0) changeSha = head;
    }

    const why = stopped
      ? "Stopped."
      : result.isError || done.exitCode !== 0
        ? failure("Claude Code stopped with an error", { stdout: result.reply ?? "", stderr: done.stderr })
        : null;
    return await ended(sandbox, input, { reply: why ? null : result.reply, failure: why, sessionId, changeSha });
  } catch (e) {
    return await ended(sandbox, input, { failure: `The PM's sandbox failed: ${e instanceof Error ? e.message : String(e)}` });
  }
}

/** Reads the session file and branch back, and pauses the sandbox for the next turn. */
async function ended(
  sandbox: PmSandbox,
  input: E2bTurnInput,
  outcome: { reply?: string | null; failure: string | null; sessionId?: string; changeSha?: string | null },
): Promise<E2bTurnResult> {
  const sessionId = outcome.sessionId ?? input.sessionId;
  let file: PackedFile = "";
  try {
    const text = await sandbox.read(`${PM_SESSIONS_DIR}/${sessionId}.jsonl`);
    if (text.trim()) file = gzipSync(Buffer.from(text, "utf8")).toString("base64");
  } catch {
    // No file: the next turn starts from the summary.
  }
  const branch = (await sandbox.run(`cd ${PM_REPO_DIR} && git rev-parse --abbrev-ref HEAD`).catch(() => null))?.stdout.trim() || "HEAD";
  await sandbox.keepFor(IDLE_MS).catch(() => undefined);
  await sandbox.pause().catch(() => undefined);
  return {
    sandboxId: sandbox.id,
    reply: outcome.reply ?? null,
    failure: outcome.failure,
    sessionId,
    file,
    branch,
    changeSha: outcome.changeSha ?? null,
  };
}

/** Kills the board's sandbox, on Clear. */
export async function killPmSandbox(sandboxId: string, e2bKey: string): Promise<void> {
  await pmSandboxes().kill(sandboxId, e2bKey);
}

/** Whether the board's last turn ran in E2B: Stop then has no CI job to cancel. */
export async function ranInE2b(projectId: string): Promise<boolean> {
  return (await repository().pmSession(projectId))?.where === "e2b";
}
