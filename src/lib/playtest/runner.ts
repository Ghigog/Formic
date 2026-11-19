import "server-only";

import { redact } from "@/lib/secrets/redact";
import { setupScript } from "@/lib/toolchains";
import { APP_PORT, PLAYTEST_SCRIPT, detect, portFromLine, type PlaytestKind } from "./detect";
import { diagnose, type Fault } from "./diagnose";
import { FETCH_CAPTURE_LIBRARY, HELPER_SCRIPT, PROXY_PATH, PROXY_PORT, PROXY_SCRIPT } from "./proxy-script";

/**
 * Starts a product in an E2B sandbox for Playtest, and stops it. See
 * docs/plans/playtest.md, "How a session runs".
 *
 * The sandbox gets the clone and nothing else: the token is taken out of the
 * remote before any of the project's code runs, and no AI key or Formic
 * setting is passed in.
 */

export type PlaytestStage = "sandbox" | "clone" | "install" | "start";

export interface StartOptions {
  apiKey: string;
  /** With the token in it. Used for the clone only. */
  cloneUrl: string;
  /** The same remote with no credential, which replaces it after the clone. */
  bareUrl: string;
  branch: string;
  /** How long the sandbox may live, all told. */
  lifetimeMs: number;
  /** How long it may take to come up. */
  startMs: number;
  /** The Formic page's origin, the only one the capture helper answers. */
  formicOrigin: string;
  onStage: (stage: PlaytestStage, label?: string) => void;
  onLog: (line: string) => void;
  /** Called with the sandbox's id as soon as there is one, so a stop can reach it. */
  onSandbox: (id: string) => void;
  signal?: AbortSignal;
}

export interface Started {
  url: string;
  commitSha: string | null;
  kind: PlaytestKind;
}

export interface PlaytestRunner {
  start(options: StartOptions): Promise<Started>;
  kill(sandboxId: string, apiKey: string): Promise<void>;
}

/**
 * Whose a failure is. "project" is the repository's own (its install, its
 * export, a server that never answers, a project Playtest cannot start), which
 * an agent can fix with a ticket. "playtest" is Playtest's or the sandbox's
 * (no sandbox, a fetch that failed, the time limit), which no change to the
 * repository can fix, so no agent is offered.
 */
export type PlaytestFault = Fault;

export class PlaytestError extends Error {
  constructor(
    message: string,
    readonly fault: PlaytestFault = "playtest",
  ) {
    super(message);
    this.name = "PlaytestError";
  }
}

type Cmd = { exitCode: number; stdout: string; stderr: string };
type RunOpts = {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  background?: boolean;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
};
type E2BSandbox = {
  sandboxId: string;
  /** A background run resolves to a handle whose wait() settles when the process exits. */
  commands: { run(cmd: string, opts?: RunOpts): Promise<Cmd & { wait?: () => Promise<Cmd> }> };
  files: { write(path: string, data: string): Promise<unknown> };
  getHost(port: number): string;
  kill(): Promise<unknown>;
};
type E2BModule = {
  Sandbox: {
    create(opts: { apiKey: string; timeoutMs: number }): Promise<E2BSandbox>;
    kill(id: string, opts?: { apiKey?: string }): Promise<unknown>;
  };
};

const REPO = "/home/user/repo";
/** What the toolchains installed (formic_bin), ahead of the rest. */
const ON_PATH = 'export PATH="$HOME/.formic/bin:$HOME/.local/bin:$PATH"';
const TOOLCHAIN_MS = 3 * 60 * 1000;

async function e2b(): Promise<E2BModule> {
  return (await import("@e2b/code-interpreter")) as unknown as E2BModule;
}

function lines(data: string, onLog: (line: string) => void, also?: (line: string) => void) {
  for (const raw of redact(data).split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    onLog(line);
    also?.(line);
  }
}

/** Runs a command and throws its last lines when it fails. E2B raises on a non-zero exit. */
async function run(
  sb: E2BSandbox,
  cmd: string,
  opts: RunOpts & { onLog: (l: string) => void; what: string; fault: PlaytestFault },
): Promise<Cmd> {
  const tail: string[] = [];
  const keep = (l: string) => {
    tail.push(l);
    if (tail.length > 12) tail.shift();
  };
  try {
    const r = await sb.commands.run(cmd, {
      cwd: opts.cwd,
      envs: opts.envs,
      timeoutMs: opts.timeoutMs,
      onStdout: (d) => lines(d, opts.onLog, keep),
      onStderr: (d) => lines(d, opts.onLog, keep),
    });
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
    return r;
  } catch (e) {
    const why = redact(e instanceof Error ? e.message : String(e));
    // A sandbox out of memory or disk is Playtest's, whichever step it hit.
    const found = diagnose(tail, why);
    throw new PlaytestError(
      `${opts.what} failed${/timeout|deadline/i.test(why) ? ", out of time" : ""}.${found ? ` ${found.message}` : ""}${tail.length ? `\n${tail.join("\n")}` : ""}`,
      found?.fault ?? opts.fault,
    );
  }
}

export const e2bRunner: PlaytestRunner = {
  async start(o) {
    const deadline = Date.now() + o.startMs;
    const left = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new PlaytestError("It took longer than the time a playtest has to start.");
      return ms;
    };
    const aborted = () => {
      if (o.signal?.aborted) throw new PlaytestError("Stopped.");
    };

    o.onStage("sandbox");
    const { Sandbox } = await e2b();
    let sb: E2BSandbox;
    try {
      sb = await Sandbox.create({ apiKey: o.apiKey, timeoutMs: o.lifetimeMs });
    } catch (e) {
      throw new PlaytestError(`Could not open an E2B sandbox: ${redact(e instanceof Error ? e.message : String(e))}`);
    }
    o.onSandbox(sb.sandboxId);
    aborted();

    // The last lines of everything, to read a failure that has no command of its own (a server that died).
    const recent: string[] = [];
    const onLog = (line: string) => {
      o.onLog(line);
      recent.push(line);
      if (recent.length > 20) recent.shift();
    };

    o.onStage("clone");
    // Large files (Git LFS) are fetched while the remote still has the token; then the token is taken out.
    await run(sb, cloneScript(o.branch, o.cloneUrl, o.bareUrl), {
      timeoutMs: Math.min(left(), 5 * 60 * 1000),
      onLog,
      what: "Cloning",
      fault: "playtest",
    });
    const free = Number((await sb.commands.run(`df -Pk ${REPO} | awk 'NR==2 {print $4}'`).catch(() => null))?.stdout.trim());
    if (free && free < MIN_FREE_KB) {
      throw new PlaytestError(
        `The sandbox has ${Math.round(free / 1024)} MB of disk left after cloning, too little to install and run the project.`,
        "playtest",
      );
    }
    const sha = (await sb.commands.run(`git -C ${REPO} rev-parse HEAD`).catch(() => null))?.stdout.trim() || null;
    aborted();

    o.onStage("install");
    // The same toolchains the agents get (src/lib/toolchains). Never fatal: the project's own install may still work.
    await sb.commands
      .run(`cd ${REPO}\n${setupScript("sandbox")}`, {
        timeoutMs: Math.min(left(), TOOLCHAIN_MS),
        onStdout: (d) => lines(d, onLog),
        onStderr: (d) => lines(d, onLog),
      })
      .catch(() => undefined);
    aborted();

    const probe = await sb.commands
      .run(
        [
          `cd ${REPO}`,
          "ls -A1",
          `[ -f ${PLAYTEST_SCRIPT} ] && echo ${PLAYTEST_SCRIPT}`,
          'echo "@@package"',
          "cat package.json 2>/dev/null || echo '@@none'",
          'echo "@@presets"',
          "cat export_presets.cfg 2>/dev/null || echo '@@none'",
          'echo "@@godot"',
          ON_PATH,
          "( [ -f project.godot ] && godot --version 2>/dev/null ) || echo '@@none'",
          "true",
        ].join("\n"),
        { timeoutMs: 60_000 },
      )
      .catch(() => ({ stdout: "" }) as Cmd);
    const [files = "", pkg = "", presets = "", godot = ""] = probe.stdout.split(/^@@(?:package|presets|godot)$/m);
    const none = (s: string) => (s.trim() === "@@none" ? null : s.trim());
    const found = detect({
      files: files.split("\n").map((f) => f.trim()).filter(Boolean),
      packageJson: none(pkg),
      exportPresets: none(presets),
      godotVersion: none(godot),
    });
    if (!found.ok) throw new PlaytestError(found.reason, found.fault);
    const { plan } = found;
    o.onStage("install", plan.label);

    const appEnv = { PORT: String(APP_PORT), HOST: "0.0.0.0", BROWSER: "none", CI: "true" };
    if (plan.fetch) {
      await run(sb, `${ON_PATH}\ncd ${REPO}\n${plan.fetch}`, {
        timeoutMs: left(),
        onLog,
        what: "Fetching what Playtest needs to run it",
        fault: "playtest",
      });
    }
    if (plan.prepare) {
      await run(sb, `${ON_PATH}\ncd ${REPO}\n${plan.prepare}`, {
        envs: appEnv,
        timeoutMs: left(),
        onLog,
        what: plan.kind === "godot" ? "Exporting the game" : "Installing",
        fault: "project",
      });
    }
    aborted();

    o.onStage("start", plan.label);
    let port = APP_PORT;
    let said: number | null = null;
    // How the product's server ended, if it did: "exit status 137" when the sandbox ran out of memory.
    let exited: string | null = null;
    if (plan.serve) {
      const server = await sb.commands.run(`${ON_PATH}\ncd ${REPO} && exec ${plan.serve}`, {
        background: true,
        envs: appEnv,
        timeoutMs: 0,
        onStdout: (d) => lines(d, onLog, (l) => (said ??= portFromLine(l))),
        onStderr: (d) => lines(d, onLog, (l) => (said ??= portFromLine(l))),
      });
      void server.wait?.().then(
        (r) => (exited = `exit status ${r.exitCode}`),
        (e: unknown) => (exited = e instanceof Error ? e.message : String(e)),
      );
      // Wait for it to say where it is, or to answer on the port it was given.
      for (;;) {
        aborted();
        if (said) {
          port = said;
          break;
        }
        const up = await sb.commands
          .run(`(exec 3<>/dev/tcp/127.0.0.1/${APP_PORT}) 2>/dev/null && echo up || true`, { timeoutMs: 10_000 })
          .catch(() => null);
        if (up?.stdout.includes("up")) break;
        if (exited || left() < 1000) throw serverFailure("The product never started listening.", recent, exited);
        await sleep(2000);
      }
    }

    await sb.commands.run(`mkdir -p ${PROXY_PATH.replace(/\/proxy\.js$/, "")}`).catch(() => undefined);
    await sb.files.write(PROXY_PATH, PROXY_SCRIPT);
    await sb.files.write(PROXY_PATH.replace(/proxy\.js$/, "helper.js"), HELPER_SCRIPT);
    // Never fatal: without it, screenshots of a single canvas still work, and desktop falls back to tab capture.
    await sb.commands.run(`${ON_PATH}\n${FETCH_CAPTURE_LIBRARY}`, { timeoutMs: 60_000 }).catch(() => undefined);
    await sb.commands.run(`${ON_PATH}\nexec node ${PROXY_PATH}`, {
      background: true,
      envs: {
        PROXY_PORT: String(PROXY_PORT),
        FORMIC_ORIGIN: o.formicOrigin,
        ...(plan.staticDir ? { STATIC_DIR: `${REPO}/${plan.staticDir}` } : { APP_PORT: String(port) }),
      },
      timeoutMs: 0,
      onStderr: (d) => lines(d, o.onLog),
    });

    for (;;) {
      aborted();
      const r = await sb.commands
        .run(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PROXY_PORT}/__formic/ready || true`, { timeoutMs: 10_000 })
        .catch(() => null);
      if (r?.stdout.trim() === "200") break;
      if (!plan.serve && left() < 1000) throw new PlaytestError("Playtest could not serve the files it built.", "playtest");
      if (plan.serve && (exited || left() < 1000)) throw serverFailure("The product never answered.", recent, exited);
      await sleep(1500);
    }

    return { url: `https://${sb.getHost(PROXY_PORT)}`, commitSha: sha, kind: plan.kind };
  },

  async kill(sandboxId, apiKey) {
    const { Sandbox } = await e2b();
    await Sandbox.kill(sandboxId, { apiKey }).catch(() => {
      // Already gone, or past its own timeout: E2B reclaims it either way.
    });
  },
};

/** Below this much free disk after the clone, an install or export will not fit. */
const MIN_FREE_KB = 500 * 1024;
/** The git-lfs release fetched when the sandbox has none. */
const GIT_LFS_VERSION = "3.6.1";

/**
 * Clones with the token, fetches Git LFS files while the token is still on the
 * remote (a game's textures and audio are often in LFS, and without them the
 * export fails or the game plays with pieces missing), then takes the token out.
 */
export function cloneScript(branch: string, cloneUrl: string, bareUrl: string): string {
  const v = GIT_LFS_VERSION;
  return [
    "set -e",
    `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch ${q(branch)} ${q(cloneUrl)} ${REPO}`,
    `if grep -qs 'filter=lfs' ${REPO}/.gitattributes; then`,
    '  export PATH="$HOME/.formic/bin:$PATH"',
    "  if ! git lfs version >/dev/null 2>&1; then",
    '    case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=amd64 ;; esac',
    '    mkdir -p "$HOME/.formic/bin"',
    `    curl -fsSL "https://github.com/git-lfs/git-lfs/releases/download/v${v}/git-lfs-linux-$arch-v${v}.tar.gz" | tar -xz -C /tmp`,
    `    cp /tmp/git-lfs-${v}/git-lfs "$HOME/.formic/bin/git-lfs"`,
    "  fi",
    '  echo "Fetching large files (Git LFS)..."',
    `  git -C ${REPO} lfs install --local >/dev/null`,
    `  git -C ${REPO} lfs pull`,
    "fi",
    `git -C ${REPO} remote set-url origin ${q(bareUrl)}`,
  ].join("\n");
}

/** A server that died or never answered: what the log says, else the project's. */
function serverFailure(what: string, recent: string[], exited: string | null): PlaytestError {
  const found = diagnose(recent, exited ?? "");
  const tail = recent.slice(-12);
  return new PlaytestError(
    `${what}${exited ? ` It stopped (${exited}).` : ""}${found ? ` ${found.message}` : " The log above says why."}${tail.length ? `\n${tail.join("\n")}` : ""}`,
    found?.fault ?? "project",
  );
}

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
