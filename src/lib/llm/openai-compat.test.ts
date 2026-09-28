import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "./openai-compat";
import { PROVIDERS, provider } from "./providers";

/**
 * A stand-in for any OpenAI-format provider: answers each request with the
 * next scripted reply, and records what was sent.
 */
function fakeProvider(replies: Array<Record<string, unknown> | { status: number }>) {
  const sent: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
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

afterEach(() => vi.unstubAllGlobals());

const ask = {
  model: "deepseek/deepseek-v4.1-flash",
  messages: [{ role: "user", content: "hi" }],
} as const;

describe("the OpenAI-format client", () => {
  /**
   * Cline streams unless told otherwise, and its docs say so. This client
   * reads the body as one JSON object, so a provider that defaults to
   * Server-Sent Events turns every run into a parse error.
   */
  it("asks every provider for one JSON body rather than a stream", async () => {
    const answered = PROVIDERS.filter((p) => p.kind === "openai");
    expect(answered.length).toBeGreaterThan(1);

    for (const info of answered) {
      const sent = fakeProvider([{ role: "assistant", content: "hello" }]);
      const reply = await chat(info, "sk-test", { ...ask, messages: [...ask.messages] });

      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(`${info.baseUrl}/chat/completions`);
      expect(sent[0]!.body.stream).toBe(false);
      expect(sent[0]!.auth).toBe("Bearer sk-test");
      expect(reply.message.content).toBe("hello");
      expect(reply.tokensOut).toBe(5);
    }
  });

  it("drops JSON mode once when a model refuses it, and keeps it otherwise", async () => {
    const refused = fakeProvider([{ status: 400 }, { role: "assistant", content: '{"a":1}' }]);
    const reply = await chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages], json: true });

    expect(refused.map((r) => r.body.response_format)).toEqual([{ type: "json_object" }, undefined]);
    expect(refused.every((r) => r.body.stream === false)).toBe(true);
    expect(reply.message.content).toBe('{"a":1}');
  });
});
