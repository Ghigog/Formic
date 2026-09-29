import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main, runLoopEntry } from "./loop-entry";
import { MemoryWorkspace } from "@/lib/sandbox/workspace";
import type { FormicEvent } from "@/lib/domain/events";

/**
 * The whole point of the entry is that it runs where Formic is not: in a
 * GitHub Actions job in someone else's repository, with no database, no event
 * bus and nowhere to look a ticket up. Both are mocked to throw, so an import
 * that reaches either one fails here rather than in a job.
 */
vi.mock("@/lib/db", () => {
  throw new Error("The loop entry must not touch the database.");
});
vi.mock("@/lib/events/bus", () => {
  throw new Error("The loop entry must not touch the event bus.");
});

/**
 * A stand-in for any OpenAI-format provider: answers each request with the
 * next scripted reply, and records what was sent. The same shape as the one in
 * `src/lib/agents/openai-agents.test.ts`.
 */
function fakeProvider(replies: Array<Record<string, unknown> | { status: number }>) {
  const sent: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url,
      body: JSON.parse(String(init.body)),
      auth: new Headers(init.headers).get("authorization"),
    });
    const next = replies.shift();
    if (!next) throw new Error("No scripted reply left.");
    if ("status" in next) return new Response("bad request", { status: next.status as number });
    return Response.json({
      choices: [{ message: next, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
  return sent;
}

/** A tool call to the loop, in the OpenAI-format reply a provider sends. */
function toolCall(id: string, name: string, input: unknown) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }],
  };
}

function finish(overrides: Record<string, unknown> = {}) {
  return toolCall("call_finish", "finish", {
    summary: "Added a retry button",
    detail: "The card restarts the run.",
    verified_with: "npx vitest run",
    ...overrides,
  });
}

const TICKET = {
  key: "T-7",
  title: "Add a retry button to a failed run",
  description: "Runs fail and there is no way back.",
  acceptanceCriteria: ["A failed run can be started again from its card."],
  fileScope: ["src/app"],
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run_1",
    projectId: "p",
    ticket: TICKET,
    repo: { fullName: "acme/widgets", baseBranch: "main" },
    provider: "deepseek",
    model: "deepseek-chat",
    apiKey: "sk-deepseek",
    ...overrides,
  };
}

/** The messages the provider was sent, as the loop built them. */
function messages(sent: Array<{ body: Record<string, unknown> }>, index: number) {
  return sent[index]!.body.messages as Array<{ role: string; content: string | null }>;
}

afterEach(() => vi.unstubAllGlobals());

describe("the loop entry a GitHub Actions job runs", () => {
  it("runs the Coder Agent's loop against a checkout and reports the change", async () => {
    const sent = fakeProvider([
      toolCall("call_1", "write_file", {
        path: "src/app/retry.ts",
        contents: "export const retry = true;\n",
      }),
      finish(),
    ]);
    const checkout = new MemoryWorkspace({ "src/app/page.ts": "export {};\n" });
    const events: FormicEvent[] = [];
    const lines: string[] = [];

    const report = await runLoopEntry(payload(), {
      workspace: checkout,
      onEvent: (event) => events.push(event),
      log: (line) => lines.push(line),
    });

    expect(report.ok).toBe(true);
    expect(report).toMatchObject({
      summary: "Added a retry button",
      verifiedWith: "npx vitest run",
      alreadyDone: false,
      limit: null,
    });
    expect(report.changedFiles).toEqual(["src/app/retry.ts"]);
    expect(report.diff).toContain("+++ b/src/app/retry.ts");
    expect(report.usage).toMatchObject({ model: "deepseek-chat", tokensIn: 20, tokensOut: 10 });
    expect(await checkout.readFile("src/app/retry.ts")).toBe("export const retry = true;\n");

    // The loop ran on the ticket's own key, and reached nothing else.
    expect(sent.map((s) => s.url)).toEqual([
      "https://api.deepseek.com/v1/chat/completions",
      "https://api.deepseek.com/v1/chat/completions",
    ]);
    expect(sent[0]!.auth).toBe("Bearer sk-deepseek");

    // The brief and the prompt are the Coder Agent's own, not a second copy.
    expect(messages(sent, 0)[0]!.content).toContain("You implement one ticket in a repository");
    expect(messages(sent, 0)[0]!.content).toContain("inside a sandboxed checkout");
    expect(messages(sent, 0)[1]!.content).toContain("Ticket T-7: Add a retry button to a failed run");
    expect(messages(sent, 0)[1]!.content).toContain("- A failed run can be started again from its card.");

    // The person watching can read along: events for the caller, lines for
    // the job log.
    expect(events.some((e) => e.type === "run.progress")).toBe(true);
    expect(lines).toContain("Writing src/app/retry.ts");
    expect(lines).toContain("Change complete");
  });

  it("refuses a write outside the ticket's file scope before it reaches a file", async () => {
    const sent = fakeProvider([
      toolCall("call_1", "write_file", { path: "docs/notes.md", contents: "# notes" }),
      finish({ summary: "nothing to change" }),
    ]);
    const checkout = new MemoryWorkspace();

    const report = await runLoopEntry(payload(), { workspace: checkout, log: () => {} });

    expect(report.ok).toBe(true);
    expect(report.changedFiles).toEqual([]);
    await expect(checkout.readFile("docs/notes.md")).rejects.toThrow();
    // The agent is told why, in words it can act on.
    expect(messages(sent, 1).at(-1)?.content).toContain("outside this ticket's file scope");
  });

  it("gives the loop the checkpoint rule a job can act on, and only there", async () => {
    // A job saves the checkout and the progress file while the run works, and
    // the notes in that file are what a resumed run reads. Without them the
    // next run has the files and what they were for nowhere.
    const inJob = fakeProvider([finish()]);
    vi.stubEnv("FORMIC_PROGRESS", "/home/runner/work/_temp/formic-progress.md");
    await runLoopEntry(payload(), { workspace: new MemoryWorkspace(), log: () => {} });
    vi.unstubAllEnvs();

    const onItsOwn = fakeProvider([finish()]);
    await runLoopEntry(payload(), { workspace: new MemoryWorkspace(), log: () => {} });

    expect(messages(inJob, 0)[0]!.content).toContain("FORMIC_PROGRESS");
    expect(messages(inJob, 0)[0]!.content).toContain("your progress file");
    expect(messages(onItsOwn, 0)[0]!.content).not.toContain("FORMIC_PROGRESS");
  });

  it("turns the ticket's budget into the loop's own turn ceiling", async () => {
    // Ten turns a minute, so a six-second budget is one turn: the loop ends
    // and says which ceiling it hit, instead of being held to a wall of turns
    // it could never reach inside the budget it was given.
    fakeProvider([toolCall("call_1", "bash", { command: "echo working" }), finish()]);

    const report = await runLoopEntry(payload({ limits: { maxDurationMs: 6_000 } }), {
      workspace: new MemoryWorkspace(),
      log: () => {},
    });

    expect(report.ok).toBe(false);
    expect(!report.ok && report.error).toContain("did not converge in 1 turn");
  });
});

describe("the run's own ceilings", () => {
  it("stops when the run's time budget is spent, and names that limit", async () => {
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // What a real provider does to a request in flight when the signal
          // it was handed aborts.
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("This operation was aborted"));
          });
        }),
    );

    const report = await runLoopEntry(payload({ limits: { maxDurationMs: 30 } }), {
      workspace: new MemoryWorkspace(),
      log: () => {},
    });

    expect(aborted).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.limit).toBe("time");
    expect(!report.ok && report.blocked).toBe(true);
    expect(!report.ok && report.error).toContain("Ran out of time");
    expect(!report.ok && report.error).toContain("budget");
  });

  it("does not stop a plan that is not billed per token on money", async () => {
    fakeProvider([finish()]);

    const report = await runLoopEntry(
      payload({
        provider: "clinepass",
        model: "deepseek/deepseek-v4.1-flash",
        apiKey: "cline-key",
        limits: { maxCents: 0 },
      }),
      { workspace: new MemoryWorkspace(), log: () => {} },
    );

    expect(report.ok).toBe(true);
    expect(report.usage.costCents).toBe(0);
  });

  it("refuses a CLI agent, which belongs in an Actions job of its own", async () => {
    await expect(
      runLoopEntry(payload({ provider: "claude-code" }), { workspace: new MemoryWorkspace() }),
    ).rejects.toThrow(/CLI agent/);
  });
});

describe("the entry as the job's command", () => {
  function captureStdout() {
    const written: string[] = [];
    const write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(write);
    return { written, restore: () => spy.mockRestore() };
  }

  afterEach(() => vi.restoreAllMocks());

  it("reads the payload on stdin and prints one JSON report on stdout", async () => {
    fakeProvider([finish()]);
    const out = captureStdout();

    const code = await main(Readable.from([JSON.stringify(payload())]), {
      workspace: new MemoryWorkspace(),
      log: () => {},
    });
    out.restore();

    expect(code).toBe(0);
    const report = JSON.parse(out.written.join("")) as Record<string, unknown>;
    expect(report).toMatchObject({ ok: true, summary: "Added a retry button" });
  });

  it("says 2, and still answers in JSON, for a payload it cannot use", async () => {
    const out = captureStdout();

    const code = await main(Readable.from(["not a payload"]));
    out.restore();

    expect(code).toBe(2);
    const report = JSON.parse(out.written.join("")) as Record<string, unknown>;
    expect(report).toMatchObject({ ok: false, limit: null });
    expect(report.error).toBeTruthy();
  });

  it("reports a checkout it cannot get, rather than hanging", async () => {
    const out = captureStdout();

    // No workspace to work in and no GitHub credential to clone with: the run
    // has to say so, because a job that dies quietly helps nobody.
    const code = await main(Readable.from([JSON.stringify(payload())]));
    out.restore();

    expect(code).toBe(2);
    expect(JSON.parse(out.written.join(""))).toMatchObject({ ok: false });
  });
});

