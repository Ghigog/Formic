import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launched = vi.hoisted(() => [] as string[]);

// `launch` never runs the work: the tests call `answer` themselves.
vi.mock("@/lib/agents/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/pipeline")>()),
  launch: (_work: unknown, label: string) => {
    launched.push(label);
  },
}));

import { answer, ask, finishCliCall, GET_BACK } from "./turn";
import { savePreset } from "@/lib/agents/presets";
import { resetAgents } from "@/lib/agents/registry";
import { repository } from "@/lib/db";
import type { ColumnId } from "@/lib/domain/status";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";

/**
 * A call: each guest answers in it with the powers it has elsewhere. Agents
 * are scripted OpenAI-format providers, as in the card chat's tests.
 */

const PROJECT = "project_default";

function fakeProvider(replies: Array<Record<string, unknown>>, gate?: Promise<void>) {
  vi.stubGlobal("fetch", async () => {
    if (gate) await gate;
    const next = replies.shift();
    if (!next) throw new Error("No scripted reply left.");
    return Response.json({
      choices: [{ message: next, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
}

const say = (content: string) => ({ role: "assistant", content });
const toolCall = (name: string, args: unknown) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

async function agent(slot: ColumnId | "assistant") {
  const preset = await savePreset({ name: "agent", provider: "groq", model: "llama-3.3-70b", prompt: "", apiKey: "gsk_test" });
  if (slot === "assistant") await repository().setAssistantAgent(PROJECT, preset.id);
  else await repository().setColumnAgent(PROJECT, slot, preset.id);
}

/** A call with these guests, the person's message sent, and its pending reply. */
async function callAndAsk(guests: Array<"architect" | "coder">, text: string) {
  const repo = repository();
  const meeting = await repo.createMeeting({ projectId: PROJECT, title: "Sync", startsAt: new Date(), guests });
  await ask(PROJECT, meeting.id, text);
  const messages = await repo.callMessages(PROJECT, meeting.id);
  return { meeting, pending: messages.at(-1)! };
}

const reload = async (id: string) => (await repository().callMessage(id))!;

async function seedTicket() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "x", position: 1 });
  const [made] = await repo.createTickets([
    {
      epicId: epic.id,
      key: "T-1",
      title: "Blocked thing",
      description: "d",
      acceptanceCriteria: ["ok"],
      fileScope: ["src/a"],
      size: "S",
      storyPoints: 1,
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  return made!;
}

beforeEach(() => {
  launched.length = 0;
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetAgents();
  resetVcs();
  setVcs(new MockVcsClient("acme/widgets"));
  vi.stubEnv("AGENT_PROVIDER", "mock");
  vi.stubEnv("FORMIC_SECRET", "test");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCache();
  resetVcs();
});

describe("a call's turn", () => {
  it("stores the Architect's reply under its guest id when the message is addressed to it", async () => {
    await agent("todo");
    fakeProvider([say("The plan holds.")]);
    const { pending } = await callAndAsk(["architect"], "Architect, is the plan sound?");

    expect(pending.guestId).toBe("architect");
    expect(launched).toEqual([`call answer ${pending.id}`]);
    await answer(pending.id);

    expect(await reload(pending.id)).toMatchObject({ guestId: "architect", status: "done", content: "The plan holds." });
  });

  it("has the assistant answer a message that names nobody", async () => {
    await agent("assistant");
    fakeProvider([say("Here is the board.")]);
    const { pending } = await callAndAsk(["architect"], "How is the board doing?");

    await answer(pending.id);

    expect(await reload(pending.id)).toMatchObject({ guestId: "assistant", content: "Here is the board." });
  });

  it("brings in a guest the message asks for, and they answer it", async () => {
    await agent("in_progress");
    fakeProvider([say("I'm here.")]);
    const { meeting, pending } = await callAndAsk(["architect"], "Please get the Coder in");

    expect(pending.guestId).toBe("coder");
    expect((await repository().meetings(PROJECT)).find((m) => m.id === meeting.id)!.guests).toEqual(["architect", "coder"]);
  });

  it("lets the Coder act on a ticket in its column as its card chat would", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, { status: "blocked", stalledIn: "in_progress", blockedReason: "Waiting" });
    await agent("in_progress");
    fakeProvider([
      toolCall("act_on_card", { key: "T-1", action: { type: "close", summary: "Skipped: not needed." } }),
      say("Skipped T-1."),
    ]);
    const { pending } = await callAndAsk(["coder"], "Coder, skip T-1, it's blocked");

    await answer(pending.id);

    expect((await repository().ticketDetail(ticket.id))!.status).toBe("merged");
    expect(await reload(pending.id)).toMatchObject({ guestId: "coder", content: "Skipped T-1." });
  });

  it("refuses a card outside the Coder's column", async () => {
    const ticket = await seedTicket();
    await agent("in_progress");
    fakeProvider([
      toolCall("act_on_card", { key: "T-1", action: { type: "close", summary: "Nope." } }),
      say("It is not mine."),
    ]);
    const { pending } = await callAndAsk(["coder"], "Coder, close T-1");

    await answer(pending.id);

    expect((await repository().ticketDetail(ticket.id))!.status).not.toBe("merged");
  });

  it("keeps what the assistant proposes as a proposal", async () => {
    const ticket = await seedTicket();
    await agent("assistant");
    fakeProvider([
      toolCall("propose", { summary: "Move T-1 to review", action: { type: "move_card", key: "T-1", to: "in_review" } }),
      say("I proposed it."),
    ]);
    const { pending } = await callAndAsk([], "Move T-1 to review");

    await answer(pending.id);

    const done = await reload(pending.id);
    expect(done.proposals).toEqual([expect.objectContaining({ summary: "Move T-1 to review", state: "proposed" })]);
    expect((await repository().ticketDetail(ticket.id))!.status).not.toBe("review");
  });

  it("says it will get back when a guest is slower than the budget, then comes back with the answer as a message of its own", async () => {
    await agent("todo");
    let open!: () => void;
    fakeProvider([say("Worth the wait.")], new Promise<void>((r) => (open = r)));
    const { meeting, pending } = await callAndAsk(["architect"], "Architect, think hard");

    const running = answer(pending.id, 10);
    await vi.waitFor(async () => expect(await reload(pending.id)).toMatchObject({ status: "pending", content: GET_BACK }));
    open();
    await running;

    expect(await reload(pending.id)).toMatchObject({ status: "done", content: GET_BACK });
    const said = await repository().callMessages(PROJECT, meeting.id);
    expect(said).toHaveLength(3);
    expect(said.at(-1)).toMatchObject({ role: "assistant", guestId: "architect", status: "done", content: "About that: Worth the wait." });
  });

  it("answers a Sentinel from its latest audit, and starts none when there is none", async () => {
    await agent("assistant");
    const repo = repository();
    const meeting = await repo.createMeeting({ projectId: PROJECT, title: "Audit", startsAt: new Date(), guests: ["sentinel:tester"] });
    await ask(PROJECT, meeting.id, "Tester, how are the tests?");
    const pending = (await repo.callMessages(PROJECT, meeting.id)).at(-1)!;

    await answer(pending.id);

    expect(pending.guestId).toBe("sentinel:tester");
    expect((await reload(pending.id)).content).toContain("not audited");
    expect(await repo.auditsFor(PROJECT)).toEqual([]);
  });

  it("posts a CLI agent's answer into the call when it lands, applying a column agent's actions", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, { status: "blocked", stalledIn: "in_progress", blockedReason: "Waiting" });
    const { pending } = await callAndAsk(["coder"], "Coder, skip T-1");

    await finishCliCall(
      pending.id,
      JSON.stringify({ reply: "Skipping it.", actions: [{ key: "T-1", action: { type: "close", summary: "Skipped." } }] }),
    );

    const said = await repository().callMessages(PROJECT, pending.meetingId);
    expect(await reload(pending.id)).toMatchObject({ status: "done", content: GET_BACK });
    expect(said.at(-1)).toMatchObject({ status: "done", guestId: "coder" });
    expect(said.at(-1)!.content).toContain("Skipping it.");
    expect((await repository().ticketDetail(ticket.id))!.status).toBe("merged");
  });

  it("answers a hello at once through an API agent when the guest's own agent is a CLI one, in its own voice", async () => {
    const cli = await savePreset({ name: "plan", provider: "claude-code", model: "", prompt: "You are the Architect of a big house.", apiKey: "sk-ant-oat01-plan" });
    await repository().setColumnAgent(PROJECT, "todo", cli.id);
    await agent("assistant");
    let sent: Array<{ content: string }> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)).messages;
      return Response.json({ choices: [{ message: say("Hello! Good to hear from you."), finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const { pending } = await callAndAsk(["architect"], "Hello architect");

    await answer(pending.id);

    expect(await reload(pending.id)).toMatchObject({ guestId: "architect", status: "done", content: "Hello! Good to hear from you." });
    expect(String(sent[0]!.content)).toContain("You are the Architect of a big house.");
    expect(String(sent[0]!.content)).toContain("Greet back when greeted");
    expect(launched.filter((l) => l.includes("runner"))).toEqual([]);
  });
});
