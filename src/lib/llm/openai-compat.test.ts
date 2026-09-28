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

/** A stand-in that answers with a body of the test's own choosing. */
function fakeBody(body: unknown) {
  vi.stubGlobal("fetch", async () => Response.json(body));
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

  /**
   * ClinePass answers a request that is not streamed with the completion
   * under `data`, beside a `success` flag, and no top-level `choices`. Reading
   * only the top level called a good answer no answer.
   */
  it("reads a completion the provider wrapped in data", async () => {
    fakeBody({
      data: {
        choices: [
          { index: 0, message: { role: "assistant", content: "wrapped hello" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      },
      success: true,
    });

    const reply = await chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] });

    expect(reply.message.content).toBe("wrapped hello");
    expect(reply.tokensIn).toBe(12);
    expect(reply.tokensOut).toBe(4);
  });

  /** A top-level `choices` that is null is not a choice: the wrapped one is. */
  it("reads the wrapped completion when the top level is empty", async () => {
    fakeBody({
      choices: null,
      data: { choices: [{ index: 0, message: { role: "assistant", content: "nested" } }] },
      success: true,
    });

    const reply = await chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] });

    expect(reply.message.content).toBe("nested");
  });

  /**
   * A 200 that carries the provider's reason rather than a completion is worth
   * naming: Cline's gateway sends it as a plain string beside `success`.
   */
  it("names what the provider said when a 200 carries no completion", async () => {
    fakeBody({ error: "Unauthorized: re-authenticate your Cline account." });

    await expect(chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] })).rejects.toThrow(
      "ClinePass answered with an error: Unauthorized: re-authenticate your Cline account.",
    );
  });

  /** Neither shape, and nothing said: the plain report stands. */
  it("still reports no answer when a 200 carries neither shape", async () => {
    fakeBody({ object: "something.else" });

    await expect(chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] })).rejects.toThrow(
      "ClinePass returned no answer.",
    );
  });
});
