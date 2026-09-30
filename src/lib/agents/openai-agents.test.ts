import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodingLoop } from "./coding-loop";
import { OpenAiArchitectAgent, OpenAiProductAgent } from "./openai-agents";
import { ticketOrRerouteSchema } from "./decomposition";
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

/** One ticket's worth of work, in the shape ticketSpecSchema requires. */
const TICKET_SPEC = {
  key: "T-1",
  title: "Add a retry button to a failed run",
  userStory: { as: "a board owner", want: "retry a failed run", soThat: "I do not have to ask again" },
  context: "Runs fail and there is no way back.",
  description: "Add a retry button to the run drawer.",
  requirements: ["A button that restarts the run it belongs to."],
  acceptanceCriteria: [{ given: "a failed run", when: "I click retry", then: "the run starts again" }],
  fileScope: ["src/components/board"],
  storyPoints: 2,
  dependsOn: [],
};

describe("the ticket-or-reroute answer both Architect agents parse with", () => {
  it("takes a reroute, and does not mistake it for a ticket", () => {
    const parsed = ticketOrRerouteSchema.safeParse({ kind: "reroute", reason: "Needs a PRD." });
    expect(parsed.success && "kind" in parsed.data).toBe(true);
  });

  it("takes a whole ticket, which carries no kind of its own", () => {
    const parsed = ticketOrRerouteSchema.safeParse(TICKET_SPEC);
    expect(parsed.success && "kind" in parsed.data).toBe(false);
  });
});

describe("the Architect's draft from a raw request", () => {
  it("is one ticket when the request is one ticket's work", async () => {
    fakeProvider([{ role: "assistant", content: JSON.stringify(TICKET_SPEC) }]);
    const agent = new OpenAiArchitectAgent({ provider: "groq", model: "m", apiKey: "gsk" });

    const outcome = await agent.draftTicket(ctx(), {
      rawRequest: "Add a retry button to a failed run.",
      repoTree: [],
      attachments: [],
    });

    expect(outcome).toMatchObject({ ok: true, value: { kind: "ticket", ticket: { key: "T-1", storyPoints: 2 } } });
  });

  it("reroutes to the Backlog when the request needs a PRD and a breakdown", async () => {
    fakeProvider([
      {
        role: "assistant",
        content: JSON.stringify({ kind: "reroute", reason: "Three distinct capabilities, each its own scope." }),
      },
    ]);
    const agent = new OpenAiArchitectAgent({ provider: "groq", model: "m", apiKey: "gsk" });

    const outcome = await agent.draftTicket(ctx(), {
      rawRequest: "Add OAuth login, a settings page for connected accounts, and audit logging for sign-ins.",
      repoTree: [],
      attachments: [],
    });

    expect(outcome).toMatchObject({
      ok: true,
      value: { kind: "reroute", reason: "Three distinct capabilities, each its own scope." },
    });
  });
});

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

  it("shares its plan and its thinking with the board as it works", async () => {
    fakeProvider([
      {
        role: "assistant",
        content: "I'll plan this first.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "update_plan",
              arguments: JSON.stringify({
                steps: [
                  { step: "Read the handler", status: "in_progress" },
                  { step: "Write the fix", status: "pending" },
                ],
              }),
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
              arguments: JSON.stringify({ summary: "done", detail: "d", verified_with: null }),
            },
          },
        ],
      },
    ]);
    const events: unknown[] = [];

    const outcome = await runCodingLoop({
      ctx: { ...ctx(), emit: (e) => events.push(e) },
      workspace: new MemoryWorkspace(),
      ticketId: "t-9",
      role: "coder",
      system: "sys",
      prompt: "do it",
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "sk-deepseek",
    });

    expect(outcome.ok).toBe(true);
    expect(events).toContainEqual({
      type: "run.thought",
      runId: "run_1",
      ticketId: "t-9",
      kind: "text",
      text: "I'll plan this first.",
    });
    expect(events).toContainEqual({
      type: "ticket.plan",
      ticketId: "t-9",
      steps: [
        { step: "Read the handler", status: "in_progress" },
        { step: "Write the fix", status: "pending" },
      ],
    });
  });

  it("ends at the turn ceiling its run's budget is worth, and names it", async () => {
    // A model that keeps calling tools and never finishes: only the ceiling
    // ends this run, and the number it reports is the one it was handed.
    fakeProvider(
      Array.from({ length: 3 }, (_, i) => ({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${i}`,
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "echo working" }) },
          },
        ],
      })),
    );

    const outcome = await runCodingLoop({
      ctx: ctx(),
      workspace: new MemoryWorkspace(),
      ticketId: "t",
      role: "coder",
      system: "sys",
      prompt: "do it",
      maxTurns: 3,
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "sk-deepseek",
    });

    expect(outcome).toMatchObject({ ok: false, blocked: true });
    expect(!outcome.ok && outcome.error).toContain("did not converge in 3 turns");
  });

  it("keeps the board's progress on the plan, and asks when the plan goes stale", async () => {
    const stepCall = (id: string, name: string, input: unknown) => ({
      role: "assistant",
      content: null,
      tool_calls: [
        { id, type: "function", function: { name, arguments: JSON.stringify(input) } },
      ],
    });
    const plan = (id: string, steps: Array<{ step: string; status: string }>) =>
      stepCall(id, "update_plan", { steps });
    const sent = fakeProvider([
      plan("call_plan_1", [
        { step: "Read the handler", status: "in_progress" },
        { step: "Write the fix", status: "pending" },
      ]),
      plan("call_plan_2", [
        { step: "Read the handler", status: "done" },
        { step: "Write the fix", status: "in_progress" },
      ]),
      // Six turns of work with the plan left where it was.
      ...Array.from({ length: 6 }, (_, i) =>
        stepCall(`call_bash_${i}`, "bash", { command: "echo working" }),
      ),
      stepCall("call_finish", "finish", { summary: "done", detail: "d", verified_with: null }),
    ]);
    const progress: Array<{ label: string; fraction: number | null }> = [];

    const outcome = await runCodingLoop({
      ctx: {
        ...ctx(),
        emit: (e) => {
          if (e.type === "run.progress") progress.push({ label: e.label, fraction: e.fraction });
        },
      },
      workspace: new MemoryWorkspace(),
      ticketId: "t",
      role: "coder",
      system: "sys",
      prompt: "do it",
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "sk-deepseek",
    });

    expect(outcome.ok).toBe(true);
    // The plan is the progress bar, as it is for a CLI agent's run, and each
    // update says in the feed which step it is on.
    expect(progress.map((p) => p.label)).toContain("Plan: Step 1 of 2: Read the handler");
    expect(progress.map((p) => p.label)).toContain("Plan: Step 2 of 2: Write the fix");
    expect(progress.some((p) => p.fraction === 0.5)).toBe(true);
    // And a plan that stopped moving is asked about, rather than assumed.
    const last = sent.at(-1)!.body.messages as Array<{ role: string; content: string }>;
    expect(last.at(-1)).toMatchObject({ role: "user" });
    expect(last.at(-1)!.content).toContain("Your plan has not moved in 6 turns");
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

    const outcome = await agent.draftPrd(ctx(), {
      epicId: "e",
      rawRequest: "add x",
      attachments: [],
    });

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
    const outcome = await agent.draftPrd(ctx(), {
      epicId: "e",
      rawRequest: "add x",
      attachments: [],
    });
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
      storyPoints: 3,
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
