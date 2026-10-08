import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodingLoop } from "./coding-loop";
import { budgetFor } from "@/lib/budget/budget-for";
import { MemoryWorkspace } from "@/lib/sandbox/workspace";
import type { AgentContext } from "./ports";

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
});
