import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxError } from "./types";

/**
 * The E2B adapter against a fake SDK: it clones and branches before it says
 * ready, gives up cleanly when either fails, keeps tokens out of what it
 * reports, and turns E2B's habit of raising on a non-zero exit back into a
 * result with the reason in it. The real VM is exercised only in smoke tests.
 */

type RunOpts = { onStdout?: (d: string) => void; onStderr?: (d: string) => void; cwd?: string };
type Run = (cmd: string, opts: RunOpts) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const sdk = vi.hoisted(() => ({
  run: vi.fn<Run>(),
  read: vi.fn(async (path: string) => `contents of ${path}`),
  kill: vi.fn(async () => true),
  create: vi.fn(),
  killById: vi.fn(async () => true),
}));

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: sdk.create,
    kill: sdk.killById,
  },
}));

const { E2BSandboxProvider } = await import("./e2b");

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

function spawn(extra: Partial<Parameters<InstanceType<typeof E2BSandboxProvider>["spawn"]>[0]> = {}) {
  return new E2BSandboxProvider().spawn({
    repoFullName: "acme/app",
    cloneUrl: "https://example.test/acme/app.git",
    baseBranch: "main",
    e2bApiKey: "e2b_key",
    ...extra,
  });
}

beforeEach(() => {
  sdk.run.mockReset().mockResolvedValue(ok());
  sdk.kill.mockClear();
  sdk.killById.mockClear();
  sdk.create.mockReset().mockImplementation(async () => ({
    sandboxId: "sbx-1",
    commands: { run: sdk.run },
    files: { read: sdk.read },
    kill: sdk.kill,
    setTimeout: vi.fn(),
  }));
});

afterEach(() => vi.unstubAllEnvs());

describe("E2BSandboxProvider", () => {
  it("creates a VM with the key and TTL, clones the base branch, branches, and reports ready", async () => {
    const handle = await spawn({ branchName: "formic/t-1", ttlMs: 60_000 });

    expect(sdk.create).toHaveBeenCalledWith({ apiKey: "e2b_key", timeoutMs: 60_000 });
    expect(sdk.run.mock.calls.map(([cmd]) => cmd)).toEqual([
      "git clone --depth 50 --branch 'main' 'https://example.test/acme/app.git' repo",
      "cd repo && git checkout -b 'formic/t-1'",
    ]);
    expect(handle.id).toBe("sbx-1");
    expect(handle.state()).toBe("ready");
    expect(await handle.readFile("repo/a.ts")).toBe("contents of repo/a.ts");
    await handle.dispose();
  });

  it("refuses to start without an E2B key", async () => {
    await expect(spawn({ e2bApiKey: null })).rejects.toThrow(/E2B_API_KEY/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("wraps a VM that will not start in a SandboxError", async () => {
    sdk.create.mockRejectedValue(new Error("quota"));

    await expect(spawn()).rejects.toBeInstanceOf(SandboxError);
  });

  it("kills the VM and says why when the clone fails", async () => {
    sdk.run.mockResolvedValueOnce({ exitCode: 128, stdout: "", stderr: "Repository not found\n" });

    await expect(spawn()).rejects.toThrow("Could not clone acme/app: Repository not found");
    expect(sdk.kill).toHaveBeenCalledTimes(1);
  });

  it("kills the VM when the branch cannot be made", async () => {
    sdk.run.mockResolvedValueOnce(ok()).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "bad name" });

    await expect(spawn({ branchName: "x" })).rejects.toThrow("Could not create branch: bad name");
    expect(sdk.kill).toHaveBeenCalledTimes(1);
  });

  it("streams output line by line with tokens redacted, to the caller and the log", async () => {
    const onLog = vi.fn();
    const handle = await spawn({ onLog });
    const token = "ghp_" + "a".repeat(30);
    sdk.run.mockImplementationOnce(async (_cmd, opts) => {
      opts.onStdout?.(`one\n\ntwo ${token}\n`);
      opts.onStderr?.("warn\n");
      return { exitCode: 0, stdout: `one\ntwo ${token}\n`, stderr: "warn\n" };
    });
    const lines: string[] = [];

    const result = await handle.exec("npm test", { onStdout: (l) => lines.push(l), cwd: "repo" });

    expect(lines).toEqual(["one", "two [redacted]"]);
    expect(onLog).toHaveBeenCalledWith("stderr", "warn");
    expect(result).toEqual({ exitCode: 0, stdout: "one\ntwo [redacted]\n", stderr: "warn\n", timedOut: false });
    expect(handle.state()).toBe("ready");
    await handle.dispose();
  });

  it("keeps what a failing command printed, since E2B raises on a non-zero exit", async () => {
    const handle = await spawn();
    sdk.run.mockImplementationOnce(async (_cmd, opts) => {
      opts.onStderr?.("fatal: not a git repository\n");
      throw new Error("exit status 128");
    });

    const result = await handle.exec("git status");

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe("exit status 128: fatal: not a git repository");
    expect(handle.state()).toBe("failed");
    await handle.dispose();
  });

  it("tells a timeout apart from a failure", async () => {
    const handle = await spawn();
    sdk.run.mockRejectedValueOnce(new Error("Command timeout after 300000ms"));

    expect((await handle.exec("sleep 999")).timedOut).toBe(true);
    await handle.dispose();
  });

  it("lists changed files, and none when git fails", async () => {
    const handle = await spawn();
    sdk.run.mockResolvedValueOnce(ok("src/a.ts\n src/b.ts \n\n"));
    expect(await handle.changedFiles()).toEqual(["src/a.ts", "src/b.ts"]);

    sdk.run.mockResolvedValueOnce({ exitCode: 1, stdout: "src/a.ts", stderr: "" });
    expect(await handle.changedFiles()).toEqual([]);
    await handle.dispose();
  });

  it("disposes once, refuses work after, and tolerates a VM that will not die", async () => {
    const handle = await spawn();
    sdk.kill.mockRejectedValueOnce(new Error("gone"));

    await handle.dispose();
    await handle.dispose();

    expect(sdk.kill).toHaveBeenCalledTimes(1);
    expect(handle.state()).toBe("disposed");
    await expect(handle.exec("ls")).rejects.toBeInstanceOf(SandboxError);
  });

  it("disposes itself when its TTL runs out, even if nobody calls dispose", async () => {
    vi.useFakeTimers();
    try {
      const handle = await spawn({ ttlMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(handle.state()).toBe("disposed");
      expect(sdk.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a VM by id, and shrugs if it is already gone", async () => {
    sdk.killById.mockRejectedValueOnce(new Error("not found"));

    await expect(new E2BSandboxProvider().disposeById("sbx-9", "e2b_key")).resolves.toBeUndefined();
    expect(sdk.killById).toHaveBeenCalledWith("sbx-9", { apiKey: "e2b_key" });
  });
});
