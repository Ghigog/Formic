import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodingLoop } from "./coding-loop";
import { OpenAiArchitectAgent, OpenAiProductAgent } from "./openai-agents";
import { MemoryWorkspace, scopedWorkspace } from "@/lib/sandbox/workspace";
import type { AgentContext } from "./ports";

/**
 * A stand-in for any OpenAI-format provider: answers each request with the
 * next scripted reply, and records what was sent.
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

function ctx(): AgentContext {
  return {
    runId: "run_1",
    projectId: "p",
    emit: () => {},
    signal: new AbortController().signal,
  };
}

afterEach(() => vi.unstubAllGlobals());

const PRD = {
  summary: "s",
  problem: "p",
  scope: ["x"],
  outOfScope: [],
  technicalContext: [],
  userStories: [],
  successCriteria: ["y"],
};

describe("the coding loop on an OpenAI-format provider", () => {
  it("edits files through tool calls and finishes", async () => {
    const sent = fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "src/app/x.ts", contents: "export {};\n" }),
            },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: {
              name: "finish",
              arguments: JSON.stringify({ summary: "added x", detail: "d", verified_with: null }),
            },
          },
        ],
      },
    ]);
    const raw = new MemoryWorkspace();

    const outcome = await runCodingLoop({
      ctx: ctx(),
      workspace: scopedWorkspace(raw, ["src/app"]),
      ticketId: "t",
      role: "coder",
      system: "sys",
      prompt: "do it",
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "sk-deepseek",
    });

    expect(outcome).toMatchObject({ ok: true, value: { summary: "added x" } });
    expect(await raw.readFile("src/app/x.ts")).toBe("export {};\n");
    expect(sent[0]!.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(sent[0]!.auth).toBe("Bearer sk-deepseek");
    // The tool result goes back as a tool message tied to the call.
    const second = sent[1]!.body.messages as Array<{ role: string; tool_call_id?: string }>;
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  it("refuses to start without a key rather than trying someone else's", async () => {
    const outcome = await runCodingLoop({
      ctx: ctx(),
      workspace: new MemoryWorkspace(),
      ticketId: "t",
      role: "coder",
      system: "sys",
      prompt: "do it",
      provider: "gemini",
      model: "gemini-2.5-pro",
      apiKey: null,
    });
    expect(outcome).toMatchObject({ ok: false, blocked: true });
    expect(!outcome.ok && outcome.error).toContain("Google Gemini API key");
  });
});

describe("structured answers from OpenAI-format providers", () => {
  it("reads a PRD out of a fenced answer, correcting a bad first try", async () => {
    const sent = fakeProvider([
      { role: "assistant", content: "Here you go:\n```json\n{\"title\": \"x\"}\n```" },
      { role: "assistant", content: `\`\`\`json\n${JSON.stringify({ title: "Add x", prd: PRD })}\n\`\`\`` },
    ]);
    const agent = new OpenAiProductAgent({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey: "AIza",
    });

    const outcome = await agent.draftPrd(ctx(), { epicId: "e", rawRequest: "add x" });

    expect(outcome).toMatchObject({ ok: true, value: { title: "Add x" } });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(sent[0]!.body.response_format).toEqual({ type: "json_object" });
  });

  it("drops JSON mode for a model that refuses it", async () => {
    const sent = fakeProvider([
      { status: 400 },
      { role: "assistant", content: JSON.stringify({ title: "Add x", prd: PRD }) },
    ]);
    const agent = new OpenAiProductAgent({ provider: "groq", model: "m", apiKey: "gsk" });
    const outcome = await agent.draftPrd(ctx(), { epicId: "e", rawRequest: "add x" });
    expect(outcome.ok).toBe(true);
    expect(sent[1]!.body.response_format).toBeUndefined();
  });

  it("sends an unsafe ticket graph back to the Architect as a correction", async () => {
    const ticket = (key: string, dependsOn: string[]) => ({
      key,
      title: key,
      userStory: { as: "a board owner", want: "d", soThat: "my work moves on" },
      context: "Why it is needed.",
      description: "d",
      requirements: ["Covered by a test"],
      acceptanceCriteria: [{ given: "the board", when: "it runs", then: "a" }],
      fileScope: ["src/lib"],
      size: "S",
      dependsOn,
    });
    const sent = fakeProvider([
      // Two tickets that can run at once and write the same files.
      { role: "assistant", content: JSON.stringify({ tickets: [ticket("T-1", []), ticket("T-2", [])] }) },
      { role: "assistant", content: JSON.stringify({ tickets: [ticket("T-1", []), ticket("T-2", ["T-1"])] }) },
    ]);
    const agent = new OpenAiArchitectAgent({ provider: "openai", model: "m", apiKey: "sk" });

    const outcome = await agent.decompose(ctx(), {
      epicId: "e",
      title: "t",
      prd: PRD,
      repoTree: ["src"],
    });

    expect(outcome.ok).toBe(true);
    const retry = sent[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(retry.at(-1)?.content).toContain("not safe to run");
  });
});

describe("the server's Claude key", () => {
  it("is never used for a signed-in person's agent", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.x");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "s");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-operator");
    const { resetEnvCache } = await import("@/lib/secrets/env");
    resetEnvCache();
    const { anthropicClient } = await import("./anthropic");
    expect(() => anthropicClient(null)).toThrow("has no Anthropic API key");
    vi.unstubAllEnvs();
    resetEnvCache();
  });
});
