import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, chat, advertisedModel } = vi.hoisted(() => ({ create: vi.fn(), chat: vi.fn(), advertisedModel: vi.fn() }));

vi.mock("./anthropic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./anthropic")>()),
  anthropicClient: () => ({ messages: { create } }),
}));
vi.mock("@/lib/llm/openai-compat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/openai-compat")>()),
  chat,
  advertisedModel,
}));

import { claudeSpeak, openAiSpeak } from "./chat-loop";
import { provider } from "@/lib/llm/providers";

const TOOLS = [{ name: "read_file", description: "Reads", schema: { type: "object" } }];

beforeEach(() => {
  vi.clearAllMocks();
  advertisedModel.mockResolvedValue(undefined);
});

describe("claudeSpeak", () => {
  const reply = {
    content: [
      { type: "text", text: " Looking. " },
      { type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  it("returns the text, the calls and the usage of a turn", async () => {
    create.mockResolvedValue(reply);
    const speak = claudeSpeak("key", "claude-sonnet-4-5", "sys", [{ role: "user", content: "hi" }], TOOLS);

    const turn = await speak(null);

    expect(turn.text).toBe("Looking.");
    expect(turn.calls).toEqual([{ id: "c1", name: "read_file", input: { path: "a" } }]);
    expect(turn.usage).toMatchObject({ model: "claude-sonnet-4-5", tokensIn: 10, tokensOut: 5 });
    expect(create.mock.calls[0]![0].tools).toHaveLength(1);
  });

  it("sends tool results back and offers no tools when only answering", async () => {
    create.mockResolvedValue({ content: [{ type: "text", text: "Done" }], usage: { input_tokens: 1, output_tokens: 1 } });
    const speak = claudeSpeak(null, "m", "sys", [], TOOLS);

    await speak([{ id: "c1", content: "file", isError: true }], { answerOnly: true });

    const params = create.mock.calls[0]![0];
    expect(params.tools).toBeUndefined();
    expect(JSON.stringify(params.messages)).toContain('"tool_use_id":"c1"');
    expect(JSON.stringify(params.messages)).toContain('"is_error":true');
  });
});

describe("openAiSpeak", () => {
  const info = provider("openai")!;

  it("returns text, parsed calls and unparseable arguments as such", async () => {
    chat.mockResolvedValue({
      message: {
        role: "assistant",
        content: " Reading ",
        tool_calls: [
          { id: "a", type: "function", function: { name: "read_file", arguments: '{"path":"x"}' } },
          { id: "b", type: "function", function: { name: "read_file", arguments: "{oops" } },
          { id: "c", type: "function", function: { name: "read_file", arguments: "" } },
        ],
      },
      tokensIn: 7,
      tokensOut: 3,
    });
    const speak = openAiSpeak(info, "k", "gpt-x", "sys", [{ role: "user", content: "hi" }], TOOLS);

    const turn = await speak(null);

    expect(turn.text).toBe("Reading");
    expect(turn.calls.map((c) => c.input)).toEqual([{ path: "x" }, { unparseable: "{oops" }, {}]);
    expect(turn.usage).toMatchObject({ tokensIn: 7, tokensOut: 3, costTokensIn: 7 });
    expect(chat.mock.calls[0]![2].tools).toHaveLength(1);
  });

  it("passes tool results as tool messages, flags errors, and drops tools when only answering", async () => {
    chat.mockResolvedValue({ message: { role: "assistant", content: null }, tokensIn: 1, tokensOut: 1, costTokensIn: 2 });
    const speak = openAiSpeak(info, "k", "gpt-x", "sys", [], TOOLS);

    const turn = await speak(
      [
        { id: "a", content: "ok", isError: false },
        { id: "b", content: "bad", isError: true },
      ],
      { answerOnly: true },
    );

    const [, , request] = chat.mock.calls[0]!;
    expect(request.tools).toBeUndefined();
    expect(request.messages.slice(1, 3)).toEqual([
      { role: "tool", tool_call_id: "a", content: "ok" },
      { role: "tool", tool_call_id: "b", content: "Error: bad" },
    ]);
    expect(turn).toMatchObject({ text: "", calls: [], usage: { costTokensIn: 2 } });
  });

  it("looks up the advertised model once per conversation", async () => {
    chat.mockResolvedValue({ message: { role: "assistant", content: "x" }, tokensIn: 1, tokensOut: 1 });
    const speak = openAiSpeak(info, "k", "gpt-x", "sys", [], TOOLS);

    await speak(null);
    await speak(null);

    expect(advertisedModel).toHaveBeenCalledTimes(1);
  });
});
