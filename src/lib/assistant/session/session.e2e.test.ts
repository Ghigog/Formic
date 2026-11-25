import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { NextRequest } from "next/server";

import type { VcsClient } from "@/lib/vcs";

/*
 * The PM session end to end, on the in-memory repository and Formic's real
 * routes (docs/plans/pm-chat.md, PR 3): the person's message starts a turn;
 * the job (played here by the test, as the workflow would) collects its
 * session and token once, calls a Formic tool over MCP, streams its words
 * into the chat and hands the session back; Formic posts the session's own
 * reply, revokes the token and keeps the file, and the next message resumes
 * it with only what is new. Only the dispatch to GitHub Actions is faked.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/credentials", () => ({ credentialsForProject: async () => ({ repoToken: "t" }) }));
vi.mock("@/lib/events/bus", () => ({ publish: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/notify", () => ({ notifyPmAnswer: vi.fn(async () => undefined) }));
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const running = vi.hoisted(() => [] as Promise<void>[]);
vi.mock("@/lib/agents/pipeline", async (original) => ({
  ...(await original<object>()),
  launch: (work: () => Promise<void>) => void running.push(work()),
}));

const claude = vi.hoisted(() => ({
  kind: "cli" as const,
  agent: { presetId: "preset-1", info: { kind: "cli", cli: "claude", label: "Claude Code", secretName: "FORMIC_CLAUDE_CODE_TOKEN" }, model: null, brief: null, secretName: null },
}));
vi.mock("@/lib/agents/presets", async (original) => ({
  ...(await original<object>()),
  assistantAgentFor: async () => claude,
}));

const dispatched = vi.hoisted(() => [] as Array<{ messageId: string; job: string; prompt: string; session: string }>);
const takesSession = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/runner/runner", async (original) => {
  const real = await original<typeof import("@/lib/runner/runner")>();
  return {
    ...real,
    runnerTakesSession: async () => takesSession.value,
    dispatchPmTurn: async (input: { messageId: string; job: string; prompt: string; session: string }) => {
      const { repository } = await import("@/lib/db");
      await repository().updateAssistantMessage(input.messageId, { runnerJob: input.job, runnerAgent: "preset-1" });
      dispatched.push(input);
      return { ok: true };
    },
  };
});

const { repository } = await import("@/lib/db");
const { answer } = await import("@/lib/assistant/turn");
const { completeCliRun, reportUrl } = await import("@/lib/runner/runner");
const sessionRoute = await import("@/app/api/runner/session/route");
const reportRoute = await import("@/app/api/runner/report/route");
const mcpRoute = await import("@/app/api/mcp/route");
const { verifyToken } = await import("@/lib/access-tokens");
const { openFile } = await import("./store");
const { setVcs, resetVcs } = await import("@/lib/vcs");
const { ANSWER_PATH } = await import("@/lib/runner/workflow");

let n = 1;
let board: string;
/** What the job leaves on its staging branch: the session's final words. */
let reply = "";

function fakeGitHub(): VcsClient {
  return {
    name: "github",
    readFile: vi.fn(async (path: string) => (path === ANSWER_PATH ? reply : null)),
    branchHead: vi.fn(async () => null),
    deleteStagingBranch: vi.fn(async () => undefined),
    recentRuns: vi.fn(async () => []),
  } as unknown as VcsClient;
}

const get = (url: string) => sessionRoute.GET(new NextRequest(url));
const post = (url: string, body: unknown) =>
  sessionRoute.POST(new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

async function ask(text: string) {
  const repo = repository();
  await repo.addAssistantMessage({ projectId: board, role: "user", content: text });
  const pending = await repo.addAssistantMessage({ projectId: board, role: "assistant", content: "", status: "pending", speaker: "assistant" });
  await answer(board, pending.id);
  return pending.id;
}

async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await mcpRoute.POST(
    new Request("https://formic.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

beforeEach(async () => {
  globalThis.__formicMemoryStore = undefined;
  dispatched.length = 0;
  running.length = 0;
  takesSession.value = true;
  for (const v of ["DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL"]) delete process.env[v];
  process.env.FORMIC_URL = "https://formic.example";
  const repo = repository();
  const me = await repo.upsertUser({ githubId: n++, login: `pm${n}`, name: null, avatarUrl: null });
  board = (await repo.ensureProject({ ownerId: me.id, repoFullName: "me/app", name: `App ${n}`, baseBranch: "main" })).id;
  setVcs(fakeGitHub());
});

afterEach(() => {
  resetVcs();
  delete process.env.FORMIC_URL;
});

describe("the PM session, end to end", () => {
  it("answers a message with a tool call and a streamed reply, then resumes with only what is new", async () => {
    const replyId = await ask("Add a ticket for dark mode, please.");

    // A fresh session: briefed, with the person's message, sent to Actions.
    expect(dispatched).toHaveLength(1);
    const turn = dispatched[0]!;
    expect(turn.prompt).toContain("This is a Claude Code session that lasts");
    expect(turn.prompt).toContain(`This board's id is ${board}`);
    expect(turn.prompt).toContain("propose_card");
    expect(turn.prompt.endsWith("Add a ticket for dark mode, please.")).toBe(true);
    expect(turn.session).toMatch(/^https:\/\/formic\.example\/api\/runner\/session\?/);

    // The job collects its handoff once; nothing for anyone after it.
    const collected = await get(turn.session);
    expect(collected.status).toBe(200);
    const handoff = await collected.json();
    expect(handoff.file).toBe("");
    expect(handoff.mcp.url).toBe("https://formic.example/api/mcp");
    expect((await get(turn.session)).status).toBe(410);

    // The session acts through Formic's tools, on its own board.
    const made = await mcp(handoff.mcp.token, "create_backlog_card", { board, title: "Dark mode", rawRequest: "A dark theme for the board." });
    expect(made.status).toBe(200);
    expect(made.body.result.isError).toBeFalsy();
    expect((await repository().boardCards(board)).map((c) => c.title)).toContain("A dark theme for the board");

    // Its words stream into the pending reply as it writes them.
    const report = new URL(reportUrl(turn.job, Date.now())!);
    const line = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    const tool = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__formic__create_backlog_card", input: {} }] } });
    const streamed = await reportRoute.POST(
      new NextRequest(report, { method: "POST", body: JSON.stringify({ lines: [line("Adding it now."), tool] }), headers: { "content-type": "application/json" } }),
    );
    expect(streamed.status).toBe(200);
    const pending = await repository().assistantMessage(replyId);
    expect(pending?.status).toBe("pending");
    expect(pending?.content).toContain("Adding it now.");
    expect(pending?.content).toContain("› Formic: create backlog card");

    // The job hands the session back and finishes.
    const file = gzipSync('{"type":"user"}\n{"type":"assistant"}\n').toString("base64");
    expect((await post(turn.session, { sessionId: handoff.sessionId, branch: "main", file })).status).toBe(200);
    reply = "I added **Dark mode** to the Backlog.";
    await completeCliRun(board, { job: turn.job, mode: "ask", conclusion: "success", url: null });

    const done = await repository().assistantMessage(replyId);
    expect(done).toMatchObject({ status: "done", content: "I added **Dark mode** to the Backlog." });
    expect(await verifyToken(handoff.mcp.token)).toBeNull();
    const session = (await repository().pmSession(board))!;
    expect(openFile(session)).toBe(file);
    expect(session.turnJob).toBeNull();
    expect(session.summary).toContain("- PM: I added **Dark mode** to the Backlog.");
    // Its token is gone: the address cannot be used again either.
    expect((await post(turn.session, { sessionId: "x", branch: "", file: "" })).status).toBe(410);

    // The next message resumes the same session with only what is new.
    await Promise.all(running);
    await ask("Thanks. Is anything blocked?");
    expect(dispatched).toHaveLength(2);
    const next = dispatched[1]!;
    expect(next.prompt).toBe("Thanks. Is anything blocked?");
    const resumed = await (await get(next.session)).json();
    expect(resumed.sessionId).toBe(handoff.sessionId);
    expect(resumed.file).toBe(file);
  });

  it("falls back to a fresh session from the summary when a resumed one fails, and says so", async () => {
    const first = await ask("Hello");
    const turn = dispatched[0]!;
    const { sessionId } = await (await get(turn.session)).json();
    await post(turn.session, { sessionId, branch: "main", file: gzipSync("{}\n").toString("base64") });
    reply = "Hi there.";
    await completeCliRun(board, { job: turn.job, mode: "ask", conclusion: "success", url: null });
    expect((await repository().assistantMessage(first))?.status).toBe("done");
    await Promise.all(running);

    const second = await ask("Where were we?");
    const broken = dispatched[1]!;
    await get(broken.session);
    reply = "";
    await completeCliRun(board, { job: broken.job, mode: "ask", conclusion: "success", url: null });

    // Tried again, fresh, from the summary; the reply is still pending, not lost.
    expect(dispatched).toHaveLength(3);
    const again = dispatched[2]!;
    expect(again.prompt).toContain("a summary, not a replay");
    expect(again.prompt).toContain("- PM: Hi there.");
    expect(again.prompt.endsWith("Where were we?")).toBe(true);
    expect((await repository().assistantMessage(second))?.status).toBe("pending");
    const notices = (await repository().assistantMessages(board)).messages.filter((m) => m.kind === "notice");
    expect(notices.map((m) => m.content).join("\n")).toContain("Reconnected");
    expect((await (await get(again.session)).json()).file).toBe("");

    // A fresh session that fails too is the end of the ladder: the reply says so.
    await completeCliRun(board, { job: again.job, mode: "ask", conclusion: "success", url: null });
    expect(dispatched).toHaveLength(3);
    expect((await repository().assistantMessage(second))?.status).toBe("failed");
  });

  it("keeps the session and retries nothing when the PM is out of usage", async () => {
    const first = await ask("Hello");
    const turn = dispatched[0]!;
    const { sessionId } = await (await get(turn.session)).json();
    await post(turn.session, { sessionId, branch: "main", file: gzipSync("{}\n").toString("base64") });
    reply = "Hi there.";
    await completeCliRun(board, { job: turn.job, mode: "ask", conclusion: "success", url: null });
    expect((await repository().assistantMessage(first))?.status).toBe("done");
    await Promise.all(running);

    const second = await ask("Where were we?");
    const limited = dispatched[1]!;
    await get(limited.session);
    const { finishSessionAnswer } = await import("@/lib/assistant/turn");
    await finishSessionAnswer(board, second, limited.job, {
      reply: null,
      failure: "Claude Code stopped with an error: You've hit your session limit · resets 7:40pm (UTC)",
      changeSha: null,
    });

    expect(dispatched).toHaveLength(2);
    const after = await repository().assistantMessage(second);
    expect(after?.status).toBe("failed");
    expect(after?.content).toContain("out of Claude usage");
    const notices = (await repository().assistantMessages(board)).messages.filter((m) => m.kind === "notice");
    expect(notices.map((m) => m.content).join("\n")).not.toContain("Reconnected");
    expect((await repository().pmSession(board))?.fileCipher).toBeTruthy();
  });

  it("leaves a repository whose workflow predates sessions on the old way of answering", async () => {
    takesSession.value = false;
    const replyId = await ask("Hello");
    expect(dispatched).toHaveLength(0);
    expect(await repository().pmSession(board)).toBeNull();
    // The old path ran: a one-off ask job, which this fake repository cannot start.
    expect((await repository().assistantMessage(replyId))?.status).toBe("failed");
  });
});
