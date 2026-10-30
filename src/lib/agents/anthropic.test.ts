import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicArchitectAgent,
  AnthropicProductAgent,
  AnthropicShowcaseAgent,
  anthropicClient,
  billedInputTokens,
  cachedSystem,
  cachedToHere,
  compareScoutsOnClaude,
  describeError,
  usageFrom,
} from "./anthropic";
import { APIConnectionError, APIError } from "@anthropic-ai/sdk/error";
import type { AgentContext, CoderTask } from "./ports";
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

/** A non-streaming Messages API reply. */
function reply(text: string, stopReason = "end_turn", status = 200): Response {
  return Response.json(
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: text ? [{ type: "text", text }] : [],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    { status },
  );
}

function apiError(status: number, message: string): Response {
  return Response.json({ type: "error", error: { type: "api_error", message } }, { status });
}

/** Stubs fetch with the replies in order, repeating the last; returns the requests seen. */
function stubReplies(...replies: Response[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requests: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return (replies.length > 1 ? replies.shift() : replies[0]!.clone())!;
  });
  return requests;
}

function agentCtx(signal = new AbortController().signal) {
  const events: FormicEvent[] = [];
  const ctx: AgentContext = { runId: "r", projectId: "p", emit: (e) => events.push(e), signal };
  return { ctx, events };
}

describe("the Anthropic adapter's helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caches the system prompt", () => {
    expect(cachedSystem("hi")).toEqual([{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]);
  });

  it("leaves an empty conversation or an empty last message unmarked", () => {
    expect(cachedToHere([])).toEqual([]);
    const empty = [{ role: "user", content: [] as unknown[] }];
    expect(cachedToHere(empty)).toBe(empty);
  });

  it("counts a missing usage as zero", () => {
    expect(usageFrom("claude-opus-5", undefined)).toMatchObject({ tokensIn: 0, tokensOut: 0 });
    expect(billedInputTokens({})).toEqual({ tokensIn: 0, costTokensIn: 0 });
  });

  it("reuses one client per key and refuses to run without one", () => {
    expect(anthropicClient("sk-ant-same")).toBe(anthropicClient("sk-ant-same"));
    expect(anthropicClient("sk-ant-same")).not.toBe(anthropicClient("sk-ant-other"));
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "secret");
    try {
      expect(() => anthropicClient(null)).toThrow(/no Anthropic API key/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("describes connection, API and plain errors, and anything else", () => {
    expect(describeError(new APIConnectionError({}))).toBe("Could not reach the Anthropic API.");
    expect(describeError(APIError.generate(401, undefined, "bad key", new Headers()))).toContain("401");
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("x")).toBe("Unknown agent failure.");
  });
});

const PRD_REPLY = JSON.stringify({
  title: "T",
  prd: { summary: "s", problem: "p", scope: ["a"], successCriteria: ["c"] },
});
let n = 0;
const key = () => `sk-ant-extra-${n++}`;

describe("the Product Agent", () => {
  afterEach(() => vi.unstubAllGlobals());

  const draft = (config = { apiKey: key() }) =>
    new AnthropicProductAgent(config).draftPrd(agentCtx().ctx, { epicId: "e", rawRequest: "req", attachments: [] });

  /** A stream whose single text block is `text`, ending as the API says `stop`. */
  function streamed(text: string, stop: string) {
    vi.stubGlobal("fetch", async () => {
      const body = (await sse([{ type: "text", text }], "end_turn").text()).replace('"end_turn"', `"${stop}"`);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
  }

  it("fails on a refusal as blocked", async () => {
    streamed(PRD_REPLY, "refusal");
    expect(await draft()).toMatchObject({ ok: false, blocked: true });
  });

  it("returns the questions it asks beside its draft PRD, no more than three", async () => {
    const q = (n: number) => ({ question: `Q${n}?`, why: "w" });
    streamed(JSON.stringify({ ...JSON.parse(PRD_REPLY), questions: [q(1), q(2), q(3), q(4)] }), "end_turn");
    const out = await draft();
    expect(out.ok && out.value.kind === "prd" && out.value.questions).toEqual([q(1), q(2), q(3)]);
  });

  it("fails when the PRD is cut off", async () => {
    streamed(PRD_REPLY, "max_tokens");
    expect(await draft()).toMatchObject({ ok: false, blocked: false, error: expect.stringContaining("cut off") });
  });

  it("streams the document and returns the parsed PRD", async () => {
    streamed(PRD_REPLY, "end_turn");
    const { ctx, events } = agentCtx();
    const out = await new AnthropicProductAgent({ apiKey: key() }).draftPrd(ctx, {
      epicId: "e",
      rawRequest: "req",
      attachments: [],
    });
    expect(out).toMatchObject({ ok: true, value: { kind: "prd", title: "T", prd: { summary: "s", outOfScope: [] } } });
    expect(events).toContainEqual({ type: "epic.prd", epicId: "e", delta: "", done: true });
  });

  it("fails on a PRD that does not match the schema", async () => {
    streamed(JSON.stringify({ title: "T" }), "end_turn");
    expect(await draft()).toMatchObject({ ok: false, blocked: false });
  });

  it("describes an API failure", async () => {
    stubReplies(apiError(401, "invalid x-api-key"));
    const out = await draft();
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ usage: { tokensIn: 0 } });
  });
});

describe("the Architect Agent", () => {
  afterEach(() => vi.unstubAllGlobals());

  const prd = {} as never;
  const decompose = (opts: { maxAttempts?: number; signal?: AbortSignal } = {}) => {
    const { ctx, events } = agentCtx(opts.signal);
    return new AnthropicArchitectAgent({ apiKey: key() })
      .decompose(ctx, { epicId: "e", title: "T", prd, repoTree: [], maxAttempts: opts.maxAttempts })
      .then((outcome) => ({ outcome, events }));
  };

  it("stops before asking when the run was stopped", async () => {
    const requests = stubReplies(reply("{}"));
    const controller = new AbortController();
    controller.abort();
    const { outcome } = await decompose({ signal: controller.signal });
    expect(outcome).toMatchObject({ ok: false, blocked: true });
    expect(requests).toHaveLength(0);
  });

  it("corrects itself and gives up after the attempts it is allowed", async () => {
    const requests = stubReplies(reply("not json"));
    const { outcome, events } = await decompose({ maxAttempts: 2 });
    expect(outcome).toMatchObject({ ok: false, blocked: true, error: expect.stringContaining("2 attempts") });
    expect(requests).toHaveLength(2);
    // The second ask carries the model's answer and the correction.
    expect(requests[1]!.messages.slice(-2).map((m: { role: string }) => m.role)).toEqual(["assistant", "user"]);
    expect(events.map((e) => (e as { label?: string }).label)).toEqual([
      "Decomposing epic",
      "Correcting the graph (attempt 2)",
    ]);
    expect(outcome.usage).toMatchObject({ tokensIn: 20, tokensOut: 10 });
  });

  it("fails as blocked on a refusal", async () => {
    stubReplies(reply("", "refusal"));
    expect((await decompose()).outcome).toMatchObject({ ok: false, blocked: true });
  });

  it("fails on an API error", async () => {
    stubReplies(apiError(401, "boom"));
    expect((await decompose({ maxAttempts: 1 })).outcome).toMatchObject({ ok: false, blocked: false });
  });

  describe("draftTicket", () => {
    const draftTicket = () =>
      new AnthropicArchitectAgent({ apiKey: key() }).draftTicket(agentCtx().ctx, {
        rawRequest: "req",
        repoTree: [],
        attachments: [
          { kind: "image", mimeType: "image/png", base64: "AAAA", filename: "a.png" },
          { kind: "image", mimeType: "image/bmp", base64: "AAAA", filename: "a.bmp" },
          { kind: "file", mimeType: "text/plain", text: "notes", filename: "n.txt" },
        ] as never,
      });

    it("sends supported images and text files as content blocks", async () => {
      const requests = stubReplies(reply("{}"));
      await draftTicket();
      const content = requests[0]!.messages[0].content;
      expect(content.map((b: { type: string }) => b.type)).toEqual(["image", "text", "text"]);
      expect(content[1].text).toContain('Attached file "n.txt"');
      expect(content[2].text).toContain("(empty repository)");
    });

    it("fails as blocked on a refusal", async () => {
      stubReplies(reply("", "refusal"));
      expect(await draftTicket()).toMatchObject({ ok: false, blocked: true });
    });

    it("reports a malformed ticket", async () => {
      stubReplies(reply(JSON.stringify({ nonsense: true })));
      expect(await draftTicket()).toMatchObject({ ok: false, error: expect.stringContaining("malformed ticket") });
    });

    it("fails on an API error", async () => {
      stubReplies(apiError(401, "boom"));
      expect(await draftTicket()).toMatchObject({ ok: false });
    });
  });
});

describe("the Showcase Agent", () => {
  afterEach(() => vi.unstubAllGlobals());

  const summarize = (prd: unknown = { summary: "intent" }) => {
    const { ctx, events } = agentCtx();
    return new AnthropicShowcaseAgent({ apiKey: key() })
      .summarize(ctx, {
        epicId: "e",
        title: "T",
        prd: prd as never,
        ticketSummaries: [{ key: "T-1", title: "One", summary: "did it" }],
      })
      .then((outcome) => ({ outcome, events }));
  };

  it("emits and returns the trimmed markdown", async () => {
    const requests = stubReplies(reply("  # Done  "));
    const { outcome, events } = await summarize();
    expect(outcome).toMatchObject({ ok: true, value: "# Done" });
    expect(events).toContainEqual({ type: "epic.showcase", epicId: "e", markdown: "# Done" });
    expect(requests[0]!.messages[0].content).toContain("Original intent: intent");
    expect(requests[0]!.messages[0].content).toContain("- T-1 One: did it");
  });

  it("leaves out the intent when there is no PRD", async () => {
    const requests = stubReplies(reply("ok"));
    await summarize(null);
    expect(requests[0]!.messages[0].content).not.toContain("Original intent");
  });

  it("fails on a refusal, an empty answer and an API error", async () => {
    stubReplies(reply("", "refusal"));
    expect((await summarize()).outcome).toMatchObject({ ok: false, blocked: true });
    stubReplies(reply(""));
    expect((await summarize()).outcome).toMatchObject({ ok: false, error: expect.stringContaining("empty") });
    stubReplies(apiError(401, "boom"));
    expect((await summarize()).outcome).toMatchObject({ ok: false, blocked: false });
  });
});

describe("comparing scouts on Claude", () => {
  afterEach(() => vi.unstubAllGlobals());

  const task = { key: "T-1", title: "t", description: "d", acceptanceCriteria: [], fileScope: [] } as unknown as CoderTask;
  const candidates = [
    { id: "a", label: "S1", approach: "x", summary: "s", files: ["f"], diff: "d" },
    { id: "b", label: "S2", approach: "y", summary: "s", files: ["f"], diff: "d" },
  ];
  const compare = () => compareScoutsOnClaude({ apiKey: key() }, agentCtx().ctx, { task, candidates });

  it("returns the accepted verdict", async () => {
    stubReplies(reply(JSON.stringify({ pick: " s2 ", why: " better ", lessons: ["a", " "] })));
    expect(await compare()).toMatchObject({ ok: true, value: { pick: "S2", why: "better", lessons: ["a"] } });
  });

  it("rejects a pick that is not a candidate", async () => {
    stubReplies(reply(JSON.stringify({ pick: "S9", why: "x", lessons: [] })));
    expect(await compare()).toMatchObject({ ok: false, error: "Pick one of S1, S2." });
  });

  it("fails on a refusal and on an API error", async () => {
    stubReplies(reply("", "refusal"));
    expect(await compare()).toMatchObject({ ok: false, blocked: true });
    stubReplies(apiError(401, "boom"));
    expect(await compare()).toMatchObject({ ok: false, blocked: false });
  });
});
