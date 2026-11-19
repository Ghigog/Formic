import "server-only";

import { redact } from "@/lib/secrets/redact";
import { setupScript } from "@/lib/toolchains";
import { APP_PORT, PLAYTEST_SCRIPT, detect, portFromLine, type PlaytestKind } from "./detect";
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

export class PlaytestError extends Error {
  constructor(message: string) {
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
  commands: { run(cmd: string, opts?: RunOpts): Promise<Cmd> };
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
async function run(sb: E2BSandbox, cmd: string, opts: RunOpts & { onLog: (l: string) => void; what: string }): Promise<Cmd> {
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
    throw new PlaytestError(`${opts.what} failed${/timeout|deadline/i.test(why) ? ", out of time" : ""}.${tail.length ? `\n${tail.join("\n")}` : ""}`);
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

    o.onStage("clone");
    await run(
      sb,
      `git clone --depth 1 --branch ${q(o.branch)} ${q(o.cloneUrl)} ${REPO} && git -C ${REPO} remote set-url origin ${q(o.bareUrl)}`,
      { timeoutMs: Math.min(left(), 3 * 60 * 1000), onLog: o.onLog, what: "Cloning" },
    );
    const sha = (await sb.commands.run(`git -C ${REPO} rev-parse HEAD`).catch(() => null))?.stdout.trim() || null;
    aborted();

    o.onStage("install");
    // The same toolchains the agents get (src/lib/toolchains). Never fatal: the project's own install may still work.
    await sb.commands
      .run(`cd ${REPO}\n${setupScript("sandbox")}`, {
        timeoutMs: Math.min(left(), TOOLCHAIN_MS),
        onStdout: (d) => lines(d, o.onLog),
        onStderr: (d) => lines(d, o.onLog),
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
    if (!found.ok) throw new PlaytestError(found.reason);
    const { plan } = found;
    o.onStage("install", plan.label);

    const appEnv = { PORT: String(APP_PORT), HOST: "0.0.0.0", BROWSER: "none", CI: "true" };
    if (plan.prepare) {
      await run(sb, `${ON_PATH}\ncd ${REPO}\n${plan.prepare}`, {
        envs: appEnv,
        timeoutMs: left(),
        onLog: o.onLog,
        what: plan.kind === "godot" ? "Exporting the game" : "Installing",
      });
    }
    aborted();

    o.onStage("start", plan.label);
    let port = APP_PORT;
    let said: number | null = null;
    if (plan.serve) {
      await sb.commands.run(`${ON_PATH}\ncd ${REPO} && exec ${plan.serve}`, {
        background: true,
        envs: appEnv,
        timeoutMs: 0,
        onStdout: (d) => lines(d, o.onLog, (l) => (said ??= portFromLine(l))),
        onStderr: (d) => lines(d, o.onLog, (l) => (said ??= portFromLine(l))),
      });
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
        if (left() < 1000) throw new PlaytestError("The product never started listening. The log above says why.");
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
      if (left() < 1000) throw new PlaytestError("The product never answered. The log above says why.");
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

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
