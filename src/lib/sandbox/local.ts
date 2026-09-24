import "server-only";

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_TTL_MS,
  type ExecOptions,
  type ExecResult,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxState,
  SandboxError,
  type SpawnOptions,
} from "./types";
import { authenticatedCloneUrl } from "@/lib/secrets/env";
import { redact } from "@/lib/secrets/redact";

/**
 * Child processes in a temporary directory.
 *
 * This is the MVP's default and the development path: it needs no account and
 * no network beyond the clone. It is NOT isolation. A coder agent running here
 * can reach the host filesystem and network, so it belongs on a developer's
 * machine and never in front of untrusted input. E2B is the answer for that,
 * and this provider exists so the rest of the system can be built and tested
 * without one.
 */

class LocalSandbox implements SandboxHandle {
  readonly provider = "local";
  private current: SandboxState = "provisioning";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly dir: string,
    ttlMs: number,
    private readonly onLog?: SpawnOptions["onLog"],
  ) {
    // Guaranteed disposal. An agent that hangs, a worker that dies mid-run, a
    // promise nobody awaited: the sandbox still goes away.
    this.timer = setTimeout(() => {
      void this.dispose();
    }, ttlMs);
    this.timer.unref?.();
  }

  state(): SandboxState {
    return this.current;
  }

  markReady(): void {
    this.current = "ready";
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (this.disposed) {
      throw new SandboxError("This sandbox has already been disposed.");
    }

    this.current = "running";
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

    return new Promise<ExecResult>((resolve) => {
      const child = spawn("bash", ["-lc", command], {
        cwd: options.cwd ? path.join(this.dir, options.cwd) : this.dir,
        env: {
          ...process.env,
          ...options.env,
          // Keep agent-run tooling non-interactive and quiet.
          CI: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const kill = () => {
        timedOut = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(kill, timeoutMs);
      options.signal?.addEventListener("abort", kill, { once: true });

      const emit = (
        stream: "stdout" | "stderr",
        chunk: Buffer,
        sink: (line: string) => void,
      ) => {
        // Redact at the source: a clone URL carrying a token appears in git's
        // own output, and from here it would reach a log and an event stream.
        const text = redact(chunk.toString());
        for (const line of text.split("\n")) {
          if (line.length === 0) continue;
          sink(line);
          this.onLog?.(stream, line);
        }
      };

      child.stdout.on("data", (c: Buffer) => {
        const text = redact(c.toString());
        stdout += text;
        emit("stdout", c, (line) => options.onStdout?.(line));
      });
      child.stderr.on("data", (c: Buffer) => {
        const text = redact(c.toString());
        stderr += text;
        emit("stderr", c, (line) => options.onStderr?.(line));
      });

      child.on("error", (e) => {
        clearTimeout(timer);
        this.current = "failed";
        resolve({
          exitCode: 127,
          stdout,
          stderr: `${stderr}\n${redact(e.message)}`,
          timedOut,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this.current = this.disposed ? "disposed" : "ready";
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });
    });
  }

  async changedFiles(): Promise<string[]> {
    // Untracked files count: an agent that adds a file outside its scope has
    // escaped it just as surely as one that edits an existing file.
    const result = await this.exec("git add -A --intent-to-add . && git diff --name-only HEAD");
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  async readFile(relativePath: string): Promise<string> {
    const full = path.resolve(this.dir, relativePath);
    if (!full.startsWith(path.resolve(this.dir))) {
      throw new SandboxError(`Refusing to read outside the sandbox: ${relativePath}`);
    }
    return readFile(full, "utf8");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.current = "disposed";
    if (this.timer) clearTimeout(this.timer);
    await rm(this.dir, { recursive: true, force: true }).catch(() => {
      // A sandbox that cannot be removed is a disk leak, not a failed run.
    });
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly name = "local";

  async disposeById(): Promise<void> {
    // A local sandbox is a child process in this instance's own temp
    // directory: another instance has no way to reach it. Its own TTL timer
    // disposes it regardless.
  }

  async spawn(options: SpawnOptions): Promise<SandboxHandle> {
    const id = `local_${randomUUID().slice(0, 8)}`;
    const dir = await mkdtemp(path.join(tmpdir(), "formic-"));
    const sandbox = new LocalSandbox(
      id,
      dir,
      options.ttlMs ?? DEFAULT_TTL_MS,
      options.onLog,
    );

    const cloneUrl =
      options.cloneUrl ?? authenticatedCloneUrl(options.repoFullName);
    const clone = await sandbox.exec(
      `git clone --depth 50 --branch ${shellQuote(options.baseBranch)} ${shellQuote(cloneUrl)} .`,
      { timeoutMs: 5 * 60 * 1000, signal: options.signal },
    );

    if (clone.exitCode !== 0) {
      await sandbox.dispose();
      throw new SandboxError(
        `Could not clone ${options.repoFullName}: ${clone.stderr.trim() || clone.stdout.trim()}`,
      );
    }

    if (options.branchName) {
      const branch = await sandbox.exec(
        `git checkout -b ${shellQuote(options.branchName)}`,
        { signal: options.signal },
      );
      if (branch.exitCode !== 0) {
        await sandbox.dispose();
        throw new SandboxError(`Could not create branch: ${branch.stderr.trim()}`);
      }
    }

    sandbox.markReady();
    return sandbox;
  }
}

/** Single-quote for bash, escaping embedded quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
