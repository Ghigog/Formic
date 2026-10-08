import { afterEach, describe, expect, it, vi } from "vitest";
import { readWindow, runCodingLoop } from "./coding-loop";
import { budgetFor } from "@/lib/budget/budget-for";
import { MemoryWorkspace } from "@/lib/sandbox/workspace";
import type { AgentContext } from "./ports";
import type { ExecOptions, ExecResult } from "@/lib/sandbox/types";
import type { FormicEvent } from "@/lib/domain/events";

/** Answers each request with the next scripted tool call, 10 tokens in and 5 out. */
function scriptedToolCalls(count: number) {
  let sent = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    // The model list is fetched once before the first turn; only a request with a body is a turn.
    if (!init?.body) return Response.json({ data: [] });
    sent += 1;
    if (sent > count) throw new Error("The loop began a turn it should not have.");
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${sent}`,
                type: "function",
                function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
  return () => sent;
}

function run(ctx: Partial<AgentContext>) {
  return runCodingLoop({
    ctx: { runId: "r", projectId: "p", emit: () => {}, signal: new AbortController().signal, ...ctx },
    workspace: new MemoryWorkspace(),
    ticketId: "t",
    role: "coder",
    system: "sys",
    prompt: "do it",
    provider: "deepseek",
    model: "deepseek-chat",
    apiKey: "sk",
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("the coding loop's limits, between turns", () => {
  it("stops before the next turn once the token limit is reached, and names it", async () => {
    const turns = scriptedToolCalls(5);
    // 15 tokens a turn; a limit of 20 is reached after the second turn.
    const budget = budgetFor({ tokens: { mode: "FLAT", flat: 20 } }, null, { storyPoints: 1 }, "in-process");

    const outcome = await run({ budget });

    expect(turns()).toBe(2);
    expect(outcome).toMatchObject({ ok: false, blocked: true });
    const error = (outcome as { error: string }).error;
    expect(error).toContain("Token limit reached");
    expect(error).toContain("Enforced between turns");
    expect(error).toContain("retried");
    expect(error).not.toMatch(/\$|cent/i);
  });

  it("stops before the next turn once the time limit is reached, and names the rail", async () => {
    const turns = scriptedToolCalls(5);
    const budget = budgetFor(null, null, { storyPoints: 8 }, "in-process");

    const outcome = await run({ budget, startedAt: Date.now() - 5 * 60_000 });

    expect(turns()).toBe(0);
    const error = (outcome as { error: string }).error;
    expect(error).toContain("Time limit reached (5 minutes)");
    expect(error).toContain("in-process hard rail");
  });
});

describe("context compaction", () => {
  it("collapses the transcript once it grows past the ceiling, so the run keeps going", async () => {
    // Each turn's input is reported larger than the last, as a transcript that
    // only ever grows would be. The loop should collapse it back down instead
    // of resending it until the token ceiling trips.
    const messageCounts: number[] = [];
    let sent = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (!init?.body) return Response.json({ data: [] });
      sent += 1;
      const body = JSON.parse(init.body as string) as { messages: unknown[] };
      messageCounts.push(body.messages.length);
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${sent}`,
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100_000 + sent * 60_000, completion_tokens: 5 },
      });
    });

    await run({});

    // The transcript grew beyond two messages, then was compacted back to
    // system + one user turn (length 2).
    expect(sent).toBeGreaterThan(3);
    expect(Math.max(...messageCounts)).toBeGreaterThan(2);
    expect(Math.min(...messageCounts)).toBe(2);
  });

  it("compacts at a quarter of the token budget when that is below the fixed ceiling", async () => {
    // Each turn's input grows by 35k, so a transcript would never cross the
    // fixed 96k ceiling before a 120k budget is spent — but a quarter of 120k
    // is 30k, which the second turn already passes. Only the budget can
    // trigger the compaction, and the collapse shows up in the next request.
    const messageCounts: number[] = [];
    let sent = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (!init?.body) return Response.json({ data: [] });
      sent += 1;
      const body = JSON.parse(init.body as string) as { messages: unknown[] };
      messageCounts.push(body.messages.length);
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${sent}`,
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 35_000 * sent, completion_tokens: 5 },
      });
    });

    const budget = budgetFor(
      { tokens: { mode: "FLAT", flat: 120_000 } },
      null,
      { storyPoints: 1 },
      "in-process",
    );

    await run({ budget });

    // The transcript grew to four messages, then collapsed back to two on the
    // request after the budget's quarter-ceiling was crossed.
    expect(messageCounts.slice(1)).toContain(2);
  });
});

type Call = { name: string; args: Record<string, unknown> };

const finish: Call = {
  name: "finish",
  args: { summary: "done", detail: "done", verified_with: null },
};

/** Answers each request with the next scripted turn of tool calls. */
function scriptedTurns(turns: Call[][]) {
  let sent = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ data: [] });
    const calls = turns[sent++];
    if (!calls) throw new Error("The loop began a turn it should not have.");
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((call, i) => ({
              id: `call_${sent}_${i}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
}

function runIn(workspace: MemoryWorkspace, events: FormicEvent[]) {
  return runCodingLoop({
    ctx: {
      runId: "r",
      projectId: "p",
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
    },
    workspace,
    ticketId: "t",
    role: "coder",
    system: "sys",
    prompt: "do it",
    provider: "deepseek",
    model: "deepseek-chat",
    apiKey: "sk",
  });
}

describe("read_file", () => {
  const file = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

  it("returns a short file whole", () => {
    expect(readWindow(file)).toBe(file);
  });

  it("returns the lines asked for, saying where they sit", () => {
    expect(readWindow(file, 4, 2)).toBe("[Lines 4-5 of 10]\nline 4\nline 5");
    expect(readWindow(file, 9)).toBe("[Lines 9-10 of 10]\nline 9\nline 10");
  });

  it("says when the offset is past the end", () => {
    expect(readWindow(file, 50)).toContain("past the end");
  });

  it("tells the agent a long file can be read in parts", () => {
    const long = "x".repeat(20_000);
    expect(readWindow(long)).toMatch(/^\[1 lines, too long to show whole.*offset and limit/);
  });
});

describe("a turn's tool calls", () => {
  it("fetches the reads before the first edit together, and reads after it see the edit", async () => {
    let inFlight = 0;
    let most = 0;
    const workspace = new MemoryWorkspace({ "a.ts": "a", "b.ts": "b" });
    const read = workspace.readFile.bind(workspace);
    workspace.readFile = async (path) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return read(path);
    };
    const seen: string[] = [];
    scriptedTurns([
      [
        { name: "read_file", args: { path: "a.ts" } },
        { name: "read_file", args: { path: "b.ts" } },
        { name: "write_file", args: { path: "a.ts", contents: "changed" } },
        { name: "read_file", args: { path: "a.ts" } },
      ],
      [finish],
    ]);
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.body) {
        const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
        for (const m of body.messages) if (m.role === "tool") seen.push(m.content);
      }
      return original(url, init);
    });

    const outcome = await runIn(workspace, []);

    expect(outcome.ok).toBe(true);
    expect(most).toBe(2);
    expect(seen.slice(0, 4)).toEqual(["a", "b", expect.stringContaining("Wrote a.ts"), "changed"]);
  });

  it("sends one diff per file a turn changes, however many edits it made", async () => {
    const events: FormicEvent[] = [];
    scriptedTurns([
      [
        { name: "write_file", args: { path: "a.ts", contents: "one two" } },
        { name: "str_replace", args: { path: "a.ts", old_text: "one", new_text: "1" } },
        { name: "str_replace", args: { path: "a.ts", old_text: "two", new_text: "2" } },
        { name: "write_file", args: { path: "b.ts", contents: "b" } },
      ],
      [finish],
    ]);

    await runIn(new MemoryWorkspace(), events);

    const diffs = events.filter((e) => e.type === "run.diff");
    expect(diffs.map((d) => (d as { path: string }).path)).toEqual(["a.ts", "b.ts"]);
    expect((diffs[0] as { patch: string }).patch).toContain("+1 2");
  });

  it("streams a long command's head and tail, not every line", async () => {
    class Noisy extends MemoryWorkspace {
      override async exec(_command: string, options?: ExecOptions): Promise<ExecResult> {
        for (let i = 1; i <= 1_000; i++) options?.onStdout?.(`line ${i}`);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    }
    const events: FormicEvent[] = [];
    scriptedTurns([[{ name: "bash", args: { command: "npm install" } }], [finish]]);

    await runIn(new Noisy(), events);

    const lines = events.flatMap((e) => (e.type === "run.log" ? [e.line] : []));
    expect(lines.length).toBeLessThan(300);
    expect(lines.slice(0, 200)).toEqual(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`));
    expect(lines).toContain("... [749 lines not shown] ...");
    expect(lines.at(-1)).toBe("line 1000");
    expect(new Set(lines).size).toBe(lines.length);
  });
});
