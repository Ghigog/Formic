/**
 * The sandbox boundary.
 *
 * Deliberately narrow: spawn, exec, stream, dispose. The PRD hedges between
 * E2B, Modal and local child processes, so the interface is what the rest of
 * the system depends on and the provider is an implementation detail.
 */

export type SandboxState =
  | "provisioning"
  | "ready"
  | "running"
  | "failed"
  | "disposed";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was cut short by a timeout or an abort. */
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

export interface SandboxHandle {
  readonly id: string;
  readonly provider: string;
  state(): SandboxState;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Paths changed relative to the repository root, since the clone. */
  changedFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface SpawnOptions {
  /** "owner/repo". Cloned over HTTPS with the configured credential. */
  repoFullName: string;
  /**
   * Explicit clone URL, for a remote that is not github.com. When omitted the
   * URL is built from repoFullName and the configured GitHub credential.
   */
  cloneUrl?: string;
  baseBranch: string;
  /** Branch to create for this run. */
  branchName?: string;
  /** Hard ceiling. The sandbox is disposed at this point regardless. */
  ttlMs?: number;
  signal?: AbortSignal;
  onLog?: (stream: "stdout" | "stderr", line: string) => void;
  /** The project owner's E2B key. Falls back to the server's E2B_API_KEY. */
  e2bApiKey?: string | null;
}

export interface SandboxProvider {
  readonly name: string;
  spawn(options: SpawnOptions): Promise<SandboxHandle>;
  /**
   * Disposes a sandbox by id alone, with no live handle to call dispose on:
   * what a stop pressed on a different instance than the one running it has
   * to use, since that instance never spawned the handle in the first place.
   */
  disposeById(id: string, e2bApiKey?: string | null): Promise<void>;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Default lifetime. A sandbox that outlives this is a leak, not a long job. */
export const DEFAULT_TTL_MS = 20 * 60 * 1000;
