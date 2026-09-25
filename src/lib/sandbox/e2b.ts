import "server-only";

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
import { shellQuote } from "./local";
import { authenticatedCloneUrl, requireCredential } from "@/lib/secrets/env";
import { redact } from "@/lib/secrets/redact";

/**
 * E2B micro-VMs. The production path: real isolation, so model-authored code
 * cannot reach the host.
 *
 * The SDK is imported dynamically so the local provider does not pay for it,
 * and so a deployment with no E2B account never loads it at all.
 */

type E2BSandbox = {
  sandboxId: string;
  commands: {
    run(
      cmd: string,
      opts?: {
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  files: { read(path: string): Promise<string> };
  kill(): Promise<unknown>;
  setTimeout(ms: number): Promise<unknown>;
};

class E2BSandboxHandle implements SandboxHandle {
  readonly provider = "e2b";
  private current: SandboxState = "provisioning";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    readonly id: string,
    private readonly sandbox: E2BSandbox,
    ttlMs: number,
    private readonly onLog?: SpawnOptions["onLog"],
  ) {
    // Belt and braces: E2B enforces its own timeout, and this disposes the
    // handle even if the process holding it never calls dispose.
    this.timer = setTimeout(() => void this.dispose(), ttlMs);
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

    const emit = (stream: "stdout" | "stderr", data: string) => {
      for (const line of redact(data).split("\n")) {
        if (line.length === 0) continue;
        if (stream === "stdout") options.onStdout?.(line);
        else options.onStderr?.(line);
        this.onLog?.(stream, line);
      }
    };

    try {
      const result = await this.sandbox.commands.run(command, {
        cwd: options.cwd,
        envs: options.env,
        timeoutMs: options.timeoutMs ?? 5 * 60 * 1000,
        onStdout: (d) => emit("stdout", d),
        onStderr: (d) => emit("stderr", d),
      });

      this.current = "ready";
      return {
        exitCode: result.exitCode,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        timedOut: false,
      };
    } catch (e) {
      this.current = "failed";
      const message = redact(e instanceof Error ? e.message : String(e));
      // E2B raises on a non-zero exit as well as on a genuine timeout, so the
      // distinction is recovered from the message rather than assumed.
      return {
        exitCode: 1,
        stdout: "",
        stderr: message,
        timedOut: /timeout/i.test(message),
      };
    }
  }

  async changedFiles(): Promise<string[]> {
    const result = await this.exec(
      "git add -A --intent-to-add . && git diff --name-only HEAD",
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async readFile(path: string): Promise<string> {
    return this.sandbox.files.read(path);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.current = "disposed";
    if (this.timer) clearTimeout(this.timer);
    await this.sandbox.kill().catch(() => {
      // A sandbox that will not die still hits E2B's own timeout.
    });
  }
}

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";

  async spawn(options: SpawnOptions): Promise<SandboxHandle> {
    const apiKey =
      options.e2bApiKey || requireCredential("E2B_API_KEY", "The E2B sandbox provider");
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

    const mod = (await import("@e2b/code-interpreter")) as unknown as {
      Sandbox: {
        create(opts: { apiKey: string; timeoutMs: number }): Promise<E2BSandbox>;
      };
    };

    let raw: E2BSandbox;
    try {
      raw = await mod.Sandbox.create({ apiKey, timeoutMs: ttlMs });
    } catch (e) {
      throw new SandboxError("Could not start an E2B sandbox.", e);
    }

    const handle = new E2BSandboxHandle(
      raw.sandboxId,
      raw,
      ttlMs,
      options.onLog,
    );

    const cloneUrl =
      options.cloneUrl ?? authenticatedCloneUrl(options.repoFullName);
    const clone = await handle.exec(
      `git clone --depth 50 --branch ${shellQuote(options.baseBranch)} ${shellQuote(cloneUrl)} repo`,
      { timeoutMs: 5 * 60 * 1000, signal: options.signal },
    );

    if (clone.exitCode !== 0) {
      await handle.dispose();
      throw new SandboxError(
        `Could not clone ${options.repoFullName}: ${clone.stderr.trim()}`,
      );
    }

    if (options.branchName) {
      const branch = await handle.exec(
        `cd repo && git checkout -b ${shellQuote(options.branchName)}`,
        { signal: options.signal },
      );
      if (branch.exitCode !== 0) {
        await handle.dispose();
        throw new SandboxError(`Could not create branch: ${branch.stderr.trim()}`);
      }
    }

    handle.markReady();
    return handle;
  }

  async disposeById(id: string, e2bApiKey?: string | null): Promise<void> {
    const apiKey = e2bApiKey || requireCredential("E2B_API_KEY", "The E2B sandbox provider");
    const mod = (await import("@e2b/code-interpreter")) as unknown as {
      Sandbox: { kill(sandboxId: string, opts?: { apiKey?: string }): Promise<unknown> };
    };
    await mod.Sandbox.kill(id, { apiKey }).catch(() => {
      // Already gone, or this key cannot see it: nothing more to do than
      // let its own TTL reclaim it.
    });
  }
}
