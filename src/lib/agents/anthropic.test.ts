import { afterEach, describe, expect, it, vi } from "vitest";

import { billedInputTokens, cachedToHere } from "./anthropic";
import { runCodingLoop } from "./coding-loop";
import { MemoryWorkspace } from "@/lib/sandbox/workspace";
import type { FormicEvent } from "@/lib/domain/events";

describe("prompt caching", () => {
  it("marks only the last block of the conversation it sends", () => {
    const messages = [
      { role: "user", content: "Implement T-1." },
      { role: "assistant", content: [{ type: "text", text: "Reading." }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "one" },
          { type: "tool_result", tool_use_id: "b", content: "two" },
        ],
      },
    ];
    const sent = cachedToHere(messages);

    expect(sent[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "one" },
      { type: "tool_result", tool_use_id: "b", content: "two", cache_control: { type: "ephemeral" } },
    ]);
    expect(sent[0]).toBe(messages[0]);
    // The transcript kept for the next turn carries no marker.
    expect(JSON.stringify(messages)).not.toContain("cache_control");
  });

  it("turns a plain first prompt into a block it can mark", () => {
    expect(cachedToHere([{ role: "user", content: "Implement T-1." }])[0]!.content).toEqual([
      { type: "text", text: "Implement T-1.", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("bills cache writes and reads at their own rates", () => {
    expect(
      billedInputTokens({
        input_tokens: 100,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 10_000,
      }),
    ).toEqual({ tokensIn: 11_100, costTokensIn: 100 + 1_250 + 1_000 });
  });
});

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/** One scripted reply as the Messages API streams it. */
function sse(blocks: Block[], stopReason: "end_turn" | "tool_use"): Response {
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
  ];
  blocks.forEach((b, index) => {
    events.push([
      "content_block_start",
      {
        type: "content_block_start",
        index,
        content_block:
          b.type === "text" ? { type: "text", text: "" } : { type: "tool_use", id: b.id, name: b.name, input: {} },
      },
    ]);
    events.push([
      "content_block_delta",
      {
        type: "content_block_delta",
        index,
        delta:
          b.type === "text"
            ? { type: "text_delta", text: b.text }
            : { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
      },
    ]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  );
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Answers each request with the next scripted reply and keeps the requests it saw. */
function scriptedModel(replies: Response[]) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const reply = replies.shift();
    if (!reply) throw new Error("The loop asked for a reply that was not scripted.");
    return reply;
  });
  return requests;
}

const FINISH: Block = {
  type: "tool_use",
  id: "toolu_finish",
  name: "finish",
  input: { summary: "Read it.", detail: "Read a.ts and reported.", verified_with: "nothing" },
};

let keys = 0;

async function runScripted(replies: Response[]) {
  const requests = scriptedModel(replies);
  const events: FormicEvent[] = [];
  const outcome = await runCodingLoop({
    ctx: { runId: "r", projectId: "p", emit: (e) => events.push(e), signal: new AbortController().signal },
    workspace: new MemoryWorkspace({ "a.ts": "export const a = 1;\n" }),
    ticketId: "t",
    role: "coder",
    system: "sys",
    prompt: "do it",
    // A key of its own: the client, and the fetch it holds, is cached per key.
    apiKey: `sk-ant-scripted-${keys++}`,
  });
  return { outcome, events, requests };
}

describe("the Anthropic adapter, driven by a scripted model", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces the text the model streams as the agent's output", async () => {
    const { outcome, events } = await runScripted([
      sse([{ type: "text", text: "I will look at a.ts first." }, FINISH], "tool_use"),
    ]);

    expect(events).toContainEqual(
      expect.objectContaining({ type: "run.thought", kind: "text", text: "I will look at a.ts first." }),
    );
    expect(outcome).toMatchObject({ ok: true, value: { summary: "Read it." } });
    expect(outcome.usage).toMatchObject({ tokensIn: 10, tokensOut: 5 });
  });

  it("runs a tool_use with its input and sends the result back", async () => {
    const { outcome, events, requests } = await runScripted([
      sse([{ type: "tool_use", id: "toolu_read", name: "read_file", input: { path: "a.ts" } }], "tool_use"),
      sse([FINISH], "tool_use"),
    ]);

    expect(events).toContainEqual(expect.objectContaining({ type: "run.progress", label: "Reading a.ts" }));
    expect(requests).toHaveLength(2);
    const sentBack = requests[1]!.messages.at(-1)!;
    expect(sentBack.role).toBe("user");
    expect(sentBack.content).toEqual([
      expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_read", is_error: false }),
    ]);
    expect(JSON.stringify(sentBack.content)).toContain("export const a = 1;");
    expect(outcome.ok).toBe(true);
  });
});
