import "server-only";

/**
 * The E2B sandbox a board's PM session lives in (docs/plans/pm-chat.md,
 * PR 3b): the repository checked out, Claude Code installed, paused between
 * turns and resumed for the next. Narrow on purpose, so a turn can be tested
 * on a fake (setPmSandboxes) and the SDK is only loaded when it is used.
 */

export interface PmCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PmRunOptions {
  envs?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** A command started in the background: waited on, or killed by Stop. */
export interface PmCommand {
  wait(): Promise<PmCommandResult>;
  kill(): Promise<void>;
}

export interface PmSandbox {
  readonly id: string;
  /** Runs a command to its end. A non-zero exit is a result, never a throw. */
  run(command: string, options?: PmRunOptions): Promise<PmCommandResult>;
  start(command: string, options?: PmRunOptions): Promise<PmCommand>;
  write(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  /** Keeps it alive this long from now. */
  keepFor(ms: number): Promise<void>;
  pause(): Promise<void>;
  kill(): Promise<void>;
}

export interface PmSandboxes {
  create(apiKey: string, timeoutMs: number): Promise<PmSandbox>;
  /** A paused sandbox, resumed. Throws when it is gone. */
  connect(id: string, apiKey: string, timeoutMs: number): Promise<PmSandbox>;
  kill(id: string, apiKey: string): Promise<void>;
}

type E2BResult = { exitCode: number; stdout: string; stderr: string };
type E2BHandle = { wait(): Promise<E2BResult>; kill(): Promise<boolean> };
type E2BRaw = {
  sandboxId: string;
  commands: {
    run(cmd: string, opts?: Record<string, unknown>): Promise<E2BResult | E2BHandle>;
  };
  files: { write(path: string, data: string): Promise<unknown>; read(path: string): Promise<string> };
  setTimeout(ms: number): Promise<void>;
  pause(): Promise<boolean>;
  kill(): Promise<boolean>;
};
type E2BModule = {
  Sandbox: {
    create(opts: { apiKey: string; timeoutMs: number }): Promise<E2BRaw>;
    connect(id: string, opts: { apiKey: string; timeoutMs: number }): Promise<E2BRaw>;
    kill(id: string, opts: { apiKey: string }): Promise<boolean>;
  };
};

/** E2B throws on a non-zero exit, with what the command printed: a result here. */
function asResult(e: unknown): PmCommandResult {
  const err = e as Partial<E2BResult> & { message?: string };
  if (typeof err?.exitCode === "number") {
    return { exitCode: err.exitCode, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
  return { exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
}

function wrap(raw: E2BRaw): PmSandbox {
  const opts = (o: PmRunOptions = {}) => ({
    envs: o.envs,
    cwd: o.cwd,
    timeoutMs: o.timeoutMs ?? 5 * 60 * 1000,
    onStdout: o.onStdout,
    onStderr: o.onStderr,
  });
  return {
    id: raw.sandboxId,
    async run(command, o) {
      try {
        return (await raw.commands.run(command, opts(o))) as E2BResult;
      } catch (e) {
        return asResult(e);
      }
    },
    async start(command, o) {
      const handle = (await raw.commands.run(command, { ...opts(o), background: true })) as E2BHandle;
      return {
        wait: () => handle.wait().catch(asResult),
        kill: async () => {
          await handle.kill().catch(() => false);
        },
      };
    },
    async write(path, data) {
      await raw.files.write(path, data);
    },
    read: (path) => raw.files.read(path),
    keepFor: (ms) => raw.setTimeout(ms),
    async pause() {
      await raw.pause();
    },
    async kill() {
      await raw.kill().catch(() => false);
    },
  };
}

const e2b: PmSandboxes = {
  async create(apiKey, timeoutMs) {
    const mod = (await import("@e2b/code-interpreter")) as unknown as E2BModule;
    return wrap(await mod.Sandbox.create({ apiKey, timeoutMs }));
  },
  async connect(id, apiKey, timeoutMs) {
    const mod = (await import("@e2b/code-interpreter")) as unknown as E2BModule;
    return wrap(await mod.Sandbox.connect(id, { apiKey, timeoutMs }));
  },
  async kill(id, apiKey) {
    const mod = (await import("@e2b/code-interpreter")) as unknown as E2BModule;
    await mod.Sandbox.kill(id, { apiKey }).catch(() => false);
  },
};

declare global {
  var __formicPmSandboxes: PmSandboxes | undefined;
}

export function pmSandboxes(): PmSandboxes {
  return globalThis.__formicPmSandboxes ?? e2b;
}

/** For tests: a fake in E2B's place; undefined puts E2B back. */
export function setPmSandboxes(fake: PmSandboxes | undefined): void {
  globalThis.__formicPmSandboxes = fake;
}

declare global {
  var __formicPmTurns: Set<string> | undefined;
}

/** The sandbox turns this process is running, by job, from start to finish. */
export function liveE2bTurns(): Set<string> {
  return (globalThis.__formicPmTurns ??= new Set());
}
