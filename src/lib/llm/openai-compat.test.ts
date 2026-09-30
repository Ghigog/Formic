import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "./openai-compat";
import { PROVIDERS, provider } from "./providers";

/**
 * A stand-in for any OpenAI-format provider: answers each request with the
 * next scripted reply, and records what was sent.
 */
function fakeProvider(replies: Array<Record<string, unknown> | { status: number; body?: string }>) {
  const sent: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      auth: new Headers(init.headers).get("authorization"),
    });
    const next = replies.shift();
    if (!next) throw new Error("No scripted reply left.");
    if ("status" in next) {
      return new Response(typeof next.body === "string" ? next.body : "bad request", {
        status: next.status as number,
      });
    }
    return Response.json({
      choices: [{ message: next, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
  return sent;
}

/**
 * Runs out the client's own retry waits. They are real time — a second, then
 * four — which a test must not spend: with `setTimeout` faked and the promise
 * queue left real, each turn lets the mocked fetch settle and then fires
 * whatever wait the client scheduled, until no wait is left.
 */
async function runOutTheWaits(turns = 6) {
  for (let i = 0; i < turns; i++) await vi.advanceTimersByTimeAsync(30_000);
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

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // An answer that never arrived is worth asking for again; this body
      // never becomes a completion, so the report is what survives the tries.
      const refused = expect(
        chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] }),
      ).rejects.toThrow("ClinePass returned no answer.");
      await runOutTheWaits();
      await refused;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A body that will not parse is not an answer either. It used to leave the
   * client as a SyntaxError, which the retry does not recognise as the
   * provider's own failure and so never asks again about — and which reached
   * the card as a JavaScript message naming no provider and nothing to do.
   */
  it("asks again when the answer is not JSON at all, and says whose side that is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const html = "<!DOCTYPE html><html><body>502 Bad Gateway</body></html>";
      const sent = fakeProvider([
        { status: 200, body: html },
        { status: 200, body: html },
        { status: 200, body: html },
      ]);

      const answer = chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] });
      const message = answer.then(
        () => "it answered",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      await runOutTheWaits();

      // Two tries after the first, and no more.
      expect(sent).toHaveLength(3);
      // And what a person is left with names the provider and whose side it is
      // on, rather than a JavaScript parse error.
      expect(await message).toContain("ClinePass answered with something that is not JSON");
      expect(await message).toContain("ClinePass's side");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Cline's gateway answers a model that came back empty with a 500 and
   * `{"error":"empty response content","success":false}` — what killed a
   * thirty-minute run on its third turn, mid-exploration, with the card then
   * saying it needed a person. The request was fine; the answer never came.
   * The same request a moment later is usually served.
   */
  it("asks again when the provider's own side falls over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sent = fakeProvider([
        { status: 500, body: '{"error":"empty response content","success":false}' },
        { role: "assistant", content: "after the hiccup" },
      ]);

      const answer = chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] });
      await runOutTheWaits();

      expect((await answer).message.content).toBe("after the hiccup");
      expect(sent).toHaveLength(2);
      // The same request, not a different one: nothing about it was wrong.
      expect(sent[1]!.body).toEqual(sent[0]!.body);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A provider that is telling the client to stop — a spent account, a
   * rejected key — is not having a bad moment, and asking again only buries
   * the reason a person has to read.
   */
  it("does not ask again when the provider is saying a person must act", async () => {
    const sent = fakeProvider([
      { status: 402, body: '{"error":{"code":"insufficient_credits"}}' },
    ]);

    await expect(chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] })).rejects.toThrow(
      "out of credit",
    );
    expect(sent).toHaveLength(1);
  });

  /** Two tries after the first, and no more: a run stops with a reason. */
  it("stops asking after its two tries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sent = fakeProvider([{ status: 500 }, { status: 500 }, { status: 500 }]);

      // A fourth request would have no scripted reply left, and say so.
      const refused = expect(
        chat(provider("clinepass")!, "k", { ...ask, messages: [...ask.messages] }),
      ).rejects.toThrow("server error");
      await runOutTheWaits();
      await refused;

      expect(sent).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the reasoning a provider returned, and the output ceiling, on the next turn", async () => {
    const sent = fakeProvider([
      {
        role: "assistant",
        content: null,
        reasoning_content: "I should look it up.",
        tool_calls: [{ id: "c1", type: "function", function: { name: "look", arguments: "{}" } }],
      },
      { role: "assistant", content: "done" },
    ]);
    const cline = provider("clinepass")!;
    const first = await chat(cline, "k", { ...ask, messages: [...ask.messages], maxTokens: 4096 });
    await chat(cline, "k", {
      ...ask,
      messages: [...ask.messages, first.message, { role: "tool", content: "ok", tool_call_id: "c1" }],
      maxTokens: 4096,
    });

    const assistant = (sent[1]!.body.messages as Array<Record<string, unknown>>)[1]!;
    expect(assistant.reasoning_content).toBe("I should look it up.");
    expect(sent[1]!.body.max_tokens).toBe(4096);
  });

  it("does not invent reasoning_content for a provider that sent none", async () => {
    const sent = fakeProvider([{ role: "assistant", content: "hi" }, { role: "assistant", content: "again" }]);
    const cline = provider("clinepass")!;
    const first = await chat(cline, "k", { ...ask, messages: [...ask.messages] });
    await chat(cline, "k", { ...ask, messages: [...ask.messages, first.message] });

    const assistant = (sent[1]!.body.messages as Array<Record<string, unknown>>)[1]!;
    expect(assistant).not.toHaveProperty("reasoning_content");
    expect(sent[1]!.body).not.toHaveProperty("max_tokens");
    expect(sent[1]!.body).not.toHaveProperty("thinking");
  });

  it("puts thinking at the top level of the body with the reasoning effort", async () => {
    const sent = fakeProvider([{ role: "assistant", content: "hi" }]);
    await chat(provider("clinepass")!, "k", {
      ...ask,
      messages: [...ask.messages],
      thinking: { type: "enabled" },
      reasoningEffort: "low",
    });

    expect(sent[0]!.body.thinking).toEqual({ type: "enabled" });
    expect(sent[0]!.body.reasoning_effort).toBe("low");
    expect(sent[0]!.body).not.toHaveProperty("extra_body");
  });
});
