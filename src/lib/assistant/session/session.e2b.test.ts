import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VcsClient } from "@/lib/vcs";
import type { PmCommandResult, PmRunOptions, PmSandbox, PmSandboxes } from "./sandbox";

/*
 * The PM session in its E2B sandbox (docs/plans/pm-chat.md, PR 3b), on the
 * in-memory repository with E2B played by a fake: the first message makes
 * the sandbox and starts a fresh session; the next resumes the paused one;
 * a sandbox that is gone is made again from the saved file; one that cannot
 * be had sends the turn to CI. Stop kills the turn; Clear kills the sandbox.
 */

vi.mock("server-only", () => ({}));
const creds = vi.hoisted(() => ({ repoToken: "ghtok" as string | null, e2bKey: "e2b_own" as string | null, e2bFallbackUserId: null as string | null }));
vi.mock("@/lib/auth/credentials", () => ({ credentialsForProject: async () => creds }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/notify", () => ({ notifyPmAnswer: vi.fn(async () => undefined) }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));
vi.mock("@/lib/agents/pipeline", async (original) => ({
  ...(await original<object>()),
  launch: (work: () => Promise<void>) => void work(),
}));

const landed = vi.hoisted(() => [] as Array<{ sha: string; wanted: string | null }>);
vi.mock("./land", () => ({
  landPmChange: async (input: { sha: string; wanted: string | null }) => {
    landed.push({ sha: input.sha, wanted: input.wanted });
    return null;
  },
}));

const claude = vi.hoisted(() => ({
  kind: "cli" as const,
  agent: {
    presetId: "preset-1",
    info: { kind: "cli", cli: "claude", label: "Claude Code", secretName: "FORMIC_CLAUDE_CODE_TOKEN" },
    model: null as string | null,
    brief: null,
    secretName: null,
    sessionToken: "sk-ant-oat01-mine" as string | null,
  },
}));
vi.mock("@/lib/agents/presets", async (original) => ({
  ...(await original<object>()),
  assistantAgentFor: async () => claude,
}));

const dispatched = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/runner/runner", async (original) => ({
  ...(await original<typeof import("@/lib/runner/runner")>()),
  runnerTakesSession: async () => true,
  dispatchPmTurn: async (input: { job: string }) => {
    dispatched.push(input.job);
    return { ok: true };
  },
}));

const { repository } = await import("@/lib/db");
const { answer, cancelPending } = await import("@/lib/assistant/turn");
const { verifyToken } = await import("@/lib/access-tokens");
const { endPmSession, killOwnerSandboxes, setPmSandboxes } = await import("./index");
const { PM_SESSIONS_DIR, resultOf } = await import("./e2b-turn");
const { setVcs, resetVcs } = await import("@/lib/vcs");

/** What Claude Code does on its next run in the fake sandbox. */
interface Script {
  words: string;
  /** Whether it commits a change. */
  commits?: boolean;
  /** Never ends until killed. */
  hangs?: boolean;
  isError?: boolean;
  /** The context its last call carried, in tokens. */
  context?: number;
}

class FakeSandbox implements PmSandbox {
  readonly commands: string[] = [];
  readonly envs: Array<Record<string, string> | undefined> = [];
  readonly files = new Map<string, string>();
  paused = 0;
  killed = false;
  head = "base1";
  branch = "HEAD";
  kill = vi.fn(async () => {
    this.killed = true;
  });
  constructor(readonly id: string, private readonly world: FakeE2B) {}

  readonly prompts: string[] = [];
  readonly mcp: string[] = [];

  async run(command: string): Promise<PmCommandResult> {
    this.commands.push(command);
    if (command.startsWith("rm -f ")) for (const path of command.slice(6).split(" ")) this.files.delete(path);
    if (command.endsWith("git rev-parse HEAD")) return { exitCode: 0, stdout: `${this.head}\n`, stderr: "" };
    if (command.includes("--abbrev-ref")) return { exitCode: 0, stdout: `${this.branch}\n`, stderr: "" };
    if (command.includes("checkout --quiet --detach")) this.head = "base1";
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async start(command: string, options: PmRunOptions = {}) {
    this.commands.push(command);
    this.envs.push(options.envs);
    const script = this.world.next.shift() ?? { words: "Done." };
    const id = /--(?:resume|session-id) '([^']+)'/.exec(command)?.[1] ?? "none";
    let release: (r: PmCommandResult) => void = () => undefined;
    const finished = new Promise<PmCommandResult>((resolve) => (release = resolve));
    const finish = () => {
      options.onStdout?.(
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: script.words }], usage: { input_tokens: 5, cache_read_input_tokens: script.context ?? 1000 } } })}\n`,
      );
      const prior = this.files.get(`${PM_SESSIONS_DIR}/${id}.jsonl`) ?? "";
      this.files.set(`${PM_SESSIONS_DIR}/${id}.jsonl`, `${prior}{"turn":${JSON.stringify(script.words)}}\n`);
      if (script.commits) {
        this.head = "pm-sha";
        this.branch = "formic/t-1";
      }
      options.onStdout?.(
        `${JSON.stringify({ type: "result", result: script.words, is_error: !!script.isError, session_id: id, usage: { input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 } })}\n`,
      );
      release({ exitCode: script.isError ? 1 : 0, stdout: "", stderr: "" });
    };
    if (!script.hangs) queueMicrotask(finish);
    return {
      wait: () => finished,
      kill: async () => release({ exitCode: 137, stdout: "", stderr: "killed" }),
    };
  }

  async write(path: string, data: string) {
    if (path === "/tmp/formic-prompt.txt") this.prompts.push(data);
    if (path === "/tmp/formic-mcp.json") this.mcp.push(data);
    this.files.set(path, data);
  }
  async read(path: string) {
    const found = this.files.get(path);
    if (found === undefined) throw new Error("no such file");
    return found;
  }
  async keepFor() {}
  async pause() {
    this.paused++;
  }
}

class FakeE2B implements PmSandboxes {
  readonly made: FakeSandbox[] = [];
  readonly gone = new Set<string>();
  readonly killedIds: string[] = [];
  next: Script[] = [];
  failCreate = false;

  async create(apiKey: string) {
    expect(apiKey).toBe("e2b_own");
    if (this.failCreate) throw new Error("E2B is down");
    const box = new FakeSandbox(`sbx-${this.made.length + 1}`, this);
    this.made.push(box);
    return box;
  }
  async connect(id: string) {
    const box = this.made.find((b) => b.id === id);
    if (!box || this.gone.has(id)) throw new Error("sandbox not found");
    return box;
  }
  async kill(id: string) {
    this.killedIds.push(id);
  }
}

let world: FakeE2B;
let board: string;
let n = 1;
const deleted: string[] = [];

async function ask(text: string) {
  const repo = repository();
  await repo.addAssistantMessage({ projectId: board, role: "user", content: text });
  const pending = await repo.addAssistantMessage({ projectId: board, role: "assistant", content: "", status: "pending", speaker: "assistant" });
  await answer(board, pending.id);
  return pending.id;
}

async function settled(messageId: string) {
  await vi.waitFor(async () => expect((await repository().assistantMessage(messageId))?.status).not.toBe("pending"));
  return (await repository().assistantMessage(messageId))!;
}

const claudeRuns = (box: FakeSandbox) => box.commands.filter((c) => c.includes("&& claude -p"));

beforeEach(async () => {
  globalThis.__formicMemoryStore = undefined;
  world = new FakeE2B();
  setPmSandboxes(world);
  dispatched.length = 0;
  landed.length = 0;
  deleted.length = 0;
  Object.assign(creds, { repoToken: "ghtok", e2bKey: "e2b_own", e2bFallbackUserId: null });
  claude.agent.sessionToken = "sk-ant-oat01-mine";
  process.env.FORMIC_URL = "https://formic.example";
  for (const v of ["DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL"]) delete process.env[v];
  const repo = repository();
  const me = await repo.upsertUser({ githubId: n++, login: `e2b${n}`, name: null, avatarUrl: null });
  board = (await repo.ensureProject({ ownerId: me.id, repoFullName: "me/app", name: `App ${n}`, baseBranch: "main" })).id;
  setVcs({
    name: "github",
    deleteStagingBranch: vi.fn(async (b: string) => void deleted.push(b)),
    branchHead: vi.fn(async () => null),
  } as unknown as VcsClient);
});

afterEach(() => {
  setPmSandboxes(undefined);
  resetVcs();
  delete process.env.FORMIC_URL;
});

describe("the PM in its E2B sandbox", () => {
  it("makes the sandbox on the first message, answers from a fresh session, keeps its file and pauses it", async () => {
    world.next = [{ words: "Hello. The board has two stuck tickets." }];
    const id = await ask("What's going on?");
    const reply = await settled(id);

    expect(reply).toMatchObject({ status: "done", content: "Hello. The board has two stuck tickets." });
    expect(dispatched).toEqual([]);
    const [box] = world.made;
    expect(world.made).toHaveLength(1);

    // Claude Code installed, the repository cloned, and the token never left behind.
    const clone = box!.commands.find((c) => c.includes("git clone"))!;
    expect(clone).toContain("x-access-token:ghtok@github.com/me/app.git");
    expect(clone).toContain("git remote set-url origin 'https://github.com/me/app.git'");
    expect(box!.commands.some((c) => c.includes("npm install -g @anthropic-ai/claude-code"))).toBe(true);

    // A fresh session, with Formic's tools, on the person's own Claude plan.
    const run = claudeRuns(box!)[0]!;
    expect(run).toContain("--session-id");
    expect(run).toContain("--mcp-config /tmp/formic-mcp.json");
    expect(box!.envs[0]).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-mine" });
    expect(box!.commands.some((c) => c.includes("rm -f /tmp/formic-prompt.txt /tmp/formic-mcp.json"))).toBe(true);

    const session = (await repository().pmSession(board))!;
    expect(session).toMatchObject({ where: "e2b", sandboxId: "sbx-1", turnJob: null });
    expect(session.fileCipher).toBeTruthy();
    expect(box!.paused).toBe(1);
  });

  it("bounds a person's turn by steps and time, and counts what it used against the PM's agent", async () => {
    world.next = [{ words: "Hi." }];
    await settled(await ask("Hello"));
    const run = claudeRuns(world.made[0]!)[0]!;
    expect(run).toContain("--max-turns 80");
    expect(run).not.toContain("--model");
    expect((await repository().agentTokensByPreset())["preset-1"]).toEqual({ tokensIn: 1100, tokensOut: 20 });
  });

  it("runs a wake-up on the agent's own model with a shorter step limit", async () => {
    world.next = [{ words: "Answered E1-T1's question." }];
    const repo = repository();
    const pending = await repo.addAssistantMessage({ projectId: board, role: "assistant", content: "", status: "pending", speaker: "assistant" });
    await answer(board, pending.id, "[From Formic, not the person] E1-T1 asked a question.");
    await settled(pending.id);
    const run = claudeRuns(world.made[0]!)[0]!;
    expect(run).not.toContain("--model");
    expect(run).toContain("--max-turns 30");
    // Its token is a wake-up's: the MCP tools let it start agent work once.
    const owner = (await repository().projectById(board))!.ownerId!;
    expect((await repository().accessTokensForUser(owner)).map((t) => t.name)).toEqual(["PM wake-up"]);
  });

  it("starts the next message fresh from the summary once the session's context is long", async () => {
    world.next = [{ words: "Hi.", context: 200_000 }];
    await settled(await ask("Hello"));
    const session = await repository().pmSession(board);
    expect(session?.fileCipher).toBeNull();
    const notices = (await repository().assistantMessages(board)).messages.filter((m) => m.kind === "notice");
    expect(notices.map((m) => m.content).join("\n")).toContain("session got long");

    world.next = [{ words: "Short one." }];
    await settled(await ask("And now?"));
    expect(claudeRuns(world.made[0]!)[1]).toContain("--session-id");
  });

  it("resumes the paused sandbox for the next message, with the saved file and only what is new", async () => {
    world.next = [{ words: "First." }, { words: "Second." }];
    await settled(await ask("One"));
    const second = await settled(await ask("Two"));

    expect(second.content).toBe("Second.");
    expect(world.made).toHaveLength(1);
    const box = world.made[0]!;
    const run = claudeRuns(box)[1]!;
    const sessionId = (await repository().pmSession(board))!.sessionId;
    expect(run).toContain(`--resume '${sessionId}'`);
    expect(box.files.get("/tmp/formic-prompt.txt")).toBeUndefined();
    expect(box.prompts[1]).toContain("Two");
    expect(box.prompts[1]).not.toContain("One");
    // The saved file was written back in before the turn: both turns are in it.
    expect(box.files.get(`${PM_SESSIONS_DIR}/${sessionId}.jsonl`)).toContain('"First."');
    expect(box.paused).toBe(2);
  });

  it("makes the sandbox again from the saved file when E2B no longer has it", async () => {
    world.next = [{ words: "First." }, { words: "Back again." }];
    await settled(await ask("One"));
    world.gone.add("sbx-1");

    const second = await settled(await ask("Two"));
    expect(second.content).toBe("Back again.");
    expect(world.made).toHaveLength(2);
    const box = world.made[1]!;
    const sessionId = (await repository().pmSession(board))!.sessionId;
    expect(box.files.get(`${PM_SESSIONS_DIR}/${sessionId}.jsonl`)).toContain('"First."');
    expect(claudeRuns(box)[0]).toContain("--resume");
    expect((await repository().pmSession(board))?.sandboxId).toBe("sbx-2");
  });

  it("sends the turn to CI when no sandbox can be had", async () => {
    world.failCreate = true;
    const id = await ask("Hello?");
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    const session = (await repository().pmSession(board))!;
    expect(session.where).toBe("actions");
    expect(session.handoff).toBeTruthy();
    expect((await repository().assistantMessage(id))?.status).toBe("pending");
  });

  it("answers from CI as before without a token on the agent, or on the shared E2B key", async () => {
    claude.agent.sessionToken = null;
    await ask("Hello?");
    creds.e2bFallbackUserId = "someone";
    claude.agent.sessionToken = "sk-ant-oat01-mine";
    await ask("Again?");
    expect(world.made).toEqual([]);
    expect(dispatched).toHaveLength(2);
  });

  it("puts the PM's commits on the turn's staging branch for Formic to land, then tidies it", async () => {
    world.next = [{ words: "Fixed the failing test on T-1.", commits: true }];
    const id = await ask("Fix T-1");
    await settled(id);
    const box = world.made[0]!;
    const push = box.commands.find((c) => c.includes(" push "))!;
    expect(push).toMatch(/HEAD:refs\/heads\/formic-staging\/.+-change/);
    expect(landed).toEqual([{ sha: "pm-sha", wanted: "formic/t-1" }]);
    expect(deleted).toHaveLength(1);
  });

  it("stops a turn the person stopped, revokes its token and keeps the file it had", async () => {
    world.next = [{ words: "First." }, { words: "never", hangs: true }];
    await settled(await ask("One"));
    const before = (await repository().pmSession(board))!.fileCipher;

    const id = await ask("Two");
    await vi.waitFor(() => expect(claudeRuns(world.made[0]!)).toHaveLength(2));
    const sessionId = (await repository().pmSession(board))!.sessionId;
    await cancelPending(board, id);

    expect((await repository().assistantMessage(id))?.content).toBe("Stopped.");
    await vi.waitFor(() => expect(world.made[0]!.paused).toBe(2));
    const after = (await repository().pmSession(board))!;
    expect(after.fileCipher).toBe(before);
    expect(after.sessionId).toBe(sessionId);
    expect(landed).toEqual([]);
  });

  it("revokes the turn's PM token when it ends", async () => {
    world.next = [{ words: "Done." }];
    await settled(await ask("Hi"));
    const config = world.made[0]!.mcp[0]!;
    const token = /Bearer ([^"]+)/.exec(config)![1]!;
    expect(await verifyToken(token)).toBeNull();
  });

  it("kills the sandbox on Clear", async () => {
    world.next = [{ words: "Done." }];
    await settled(await ask("Hi"));
    await endPmSession(board);
    expect(world.killedIds).toEqual(["sbx-1"]);
    expect(await repository().pmSession(board)).toBeNull();
  });

  const owner = async () => (await repository().projectById(board))!.ownerId!;

  it("kills the sandbox of an owner's board before the board is deleted", async () => {
    world.next = [{ words: "Done." }];
    await settled(await ask("Hi"));
    await killOwnerSandboxes(await owner());
    expect(world.killedIds).toEqual(["sbx-1"]);
  });

  it("lets the delete go on when the kill fails", async () => {
    world.next = [{ words: "Done." }];
    await settled(await ask("Hi"));
    world.kill = async () => {
      throw new Error("E2B is down");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(killOwnerSandboxes(await owner())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("kills nothing for a board with no sandbox", async () => {
    await killOwnerSandboxes(await owner());
    expect(world.killedIds).toEqual([]);
  });
});

describe("resultOf", () => {
  it("reads the last result event: its words, an error and the session id", () => {
    const stream = [
      '{"type":"assistant"}',
      "not json",
      '{"type":"result","result":"Hi","is_error":false,"session_id":"s1"}',
    ].join("\n");
    expect(resultOf(stream)).toEqual({ reply: "Hi", isError: false, sessionId: "s1" });
    expect(resultOf("")).toEqual({ reply: null, isError: false, sessionId: null });
  });
});

describe("a sandbox turn lost to a restart", () => {
  it("is failed by the sweep with a plain reason, its token revoked, and the sandbox kept", async () => {
    world.next = [{ words: "First." }, { words: "never", hangs: true }];
    await settled(await ask("One"));
    const id = await ask("Two");
    await vi.waitFor(() => expect(claudeRuns(world.made[0]!)).toHaveLength(2));
    const { liveE2bTurns } = await import("./sandbox");
    const { recoverLostSandboxTurn } = await import("./index");

    // Still live in this process: left alone.
    expect(await recoverLostSandboxTurn(board)).toBe(false);

    // The process that ran it is gone.
    liveE2bTurns().clear();
    expect(await recoverLostSandboxTurn(board)).toBe(true);
    expect(await repository().assistantMessage(id)).toMatchObject({ status: "failed", content: expect.stringContaining("Formic restarted") });
    expect(await repository().pmSession(board)).toMatchObject({ turnJob: null, sandboxId: "sbx-1" });
    expect(await recoverLostSandboxTurn(board)).toBe(false);
  });
});
