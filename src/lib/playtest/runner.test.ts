import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The E2B runner against a fake sandbox: the commands it sends, in order, and
 * what it makes of their answers. A real sandbox is the deploy's to test.
 */

type Opts = { background?: boolean; envs?: Record<string, string>; onStdout?: (d: string) => void; onStderr?: (d: string) => void };
type Reply = { exitCode?: number; stdout?: string; throws?: string; say?: string };

const fake = vi.hoisted(() => ({
  ran: [] as Array<{ cmd: string; opts?: Opts }>,
  files: new Map<string, string>(),
  replies: [] as Array<[RegExp, Reply]>,
  createError: null as string | null,
  killed: [] as string[],
}));

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    async create() {
      if (fake.createError) throw new Error(fake.createError);
      return {
        sandboxId: "sb-1",
        getHost: (port: number) => `${port}-sb-1.e2b.app`,
        files: { write: async (p: string, d: string) => void fake.files.set(p, d) },
        commands: {
          async run(cmd: string, opts?: Opts) {
            fake.ran.push({ cmd, opts });
            const hit = fake.replies.find(([re]) => re.test(cmd))?.[1] ?? {};
            if (hit.say) opts?.onStdout?.(hit.say);
            if (hit.throws) throw new Error(hit.throws);
            return { exitCode: hit.exitCode ?? 0, stdout: hit.stdout ?? "", stderr: "" };
          },
        },
      };
    },
    async kill(id: string) {
      fake.killed.push(id);
    },
  },
}));

const { e2bRunner } = await import("./runner");

const probe = (files: string[], pkg: string | null) =>
  [files.join("\n"), "@@package", pkg ?? "@@none", "@@presets", "@@none", "@@godot", "@@none"].join("\n");

function options(over: Partial<Parameters<typeof e2bRunner.start>[0]> = {}) {
  const stages: string[] = [];
  const logs: string[] = [];
  return {
    stages,
    logs,
    o: {
      apiKey: "k",
      cloneUrl: "https://x-access-token:secret@github.com/a/b.git",
      bareUrl: "https://github.com/a/b.git",
      branch: "main",
      lifetimeMs: 60_000,
      startMs: 30_000,
      formicOrigin: "https://formic.test",
      onStage: (s: string, label?: string) => stages.push(label ? `${s}:${label}` : s),
      onLog: (l: string) => logs.push(l),
      onSandbox: vi.fn(),
      ...over,
    },
  };
}

beforeEach(() => {
  fake.ran.length = 0;
  fake.files.clear();
  fake.replies = [];
  fake.createError = null;
  fake.killed.length = 0;
});

describe("e2bRunner", () => {
  it("serves a static page through the proxy and hands back its public URL", async () => {
    fake.replies = [
      [/rev-parse HEAD/, { stdout: "abc123\n" }],
      [/ls -A1/, { stdout: probe(["index.html"], null) }],
      [/__formic\/ready/, { stdout: "200" }],
    ];
    const { o, stages } = options();
    const started = await e2bRunner.start(o);
    expect(started).toEqual({ url: "https://8484-sb-1.e2b.app", commitSha: "abc123", kind: "static" });
    expect(o.onSandbox).toHaveBeenCalledWith("sb-1");
    expect(stages).toEqual(["sandbox", "clone", "install", "install:web page", "start:web page"]);

    // The token is used to clone and then replaced by the bare remote, before any project code runs.
    const clone = fake.ran.find((r) => r.cmd.includes("git clone"))!.cmd;
    expect(clone).toContain("remote set-url origin 'https://github.com/a/b.git'");
    expect(fake.ran.findIndex((r) => r.cmd.includes("git clone"))).toBe(0);

    const proxy = fake.ran.find((r) => r.cmd.includes("node /tmp/formic-playtest/proxy.js"))!;
    expect(proxy.opts).toMatchObject({ background: true, envs: { STATIC_DIR: "/home/user/repo/.", FORMIC_ORIGIN: "https://formic.test" } });
    expect(fake.files.get("/tmp/formic-playtest/helper.js")).toContain("__FORMIC_ORIGIN__");
    // No credential reaches the product's environment.
    for (const r of fake.ran) expect(JSON.stringify(r.opts?.envs ?? {})).not.toContain("secret");
  });

  it("installs a Node app, starts its dev script and follows the port it prints", async () => {
    fake.replies = [
      [/ls -A1/, { stdout: probe(["package.json", "package-lock.json"], JSON.stringify({ scripts: { dev: "vite" } })) }],
      [/npm run dev/, { say: "  Local:   http://localhost:5173/\n" }],
      [/__formic\/ready/, { stdout: "200" }],
    ];
    const { o, logs } = options();
    const started = await e2bRunner.start(o);
    expect(started.kind).toBe("node");
    expect(fake.ran.some((r) => r.cmd.includes("npm ci"))).toBe(true);
    const serve = fake.ran.find((r) => r.cmd.includes("npm run dev"))!;
    expect(serve.opts).toMatchObject({ background: true, envs: { PORT: "3000", HOST: "0.0.0.0" } });
    const proxy = fake.ran.find((r) => r.cmd.includes("proxy.js"))!;
    expect(proxy.opts?.envs?.APP_PORT).toBe("5173");
    expect(logs).toContain("  Local:   http://localhost:5173/");
  });

  it("says what it supports when it cannot tell how to start the project", async () => {
    fake.replies = [[/ls -A1/, { stdout: probe(["main.go"], null) }]];
    await expect(e2bRunner.start(options().o)).rejects.toThrow(/web apps and Godot games/);
  });

  it("explains a failed clone with its last lines, and a sandbox that would not open", async () => {
    fake.replies = [[/git clone/, { say: "fatal: repository not found", throws: "exit status 128" }]];
    await expect(e2bRunner.start(options().o)).rejects.toThrow(/Cloning failed\.\nfatal: repository not found/);

    fake.createError = "401: invalid API key";
    await expect(e2bRunner.start(options().o)).rejects.toThrow(/Could not open an E2B sandbox: 401: invalid API key/);
  });

  it("stops when asked while it starts", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(e2bRunner.start(options({ signal: abort.signal }).o)).rejects.toThrow("Stopped.");
  });

  it("gives up when the product never answers in the time it has", async () => {
    fake.replies = [
      [/ls -A1/, { stdout: probe(["index.html"], null) }],
      [/__formic\/ready/, { stdout: "503" }],
    ];
    await expect(e2bRunner.start(options({ startMs: 50 }).o)).rejects.toThrow(/never answered|longer than the time/);
  });

  it("kills a sandbox by id", async () => {
    await e2bRunner.kill("sb-9", "k");
    expect(fake.killed).toEqual(["sb-9"]);
  });
});
