import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launched = vi.hoisted(() => [] as string[]);

// `launch` never runs the work it is given here: every assertion about what
// a message triggers reads the label instead, the same way board/service's
// tests do for a drag's own triggers.
vi.mock("@/lib/agents/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pipeline")>()),
  launch: (_work: unknown, label: string) => {
    launched.push(label);
  },
}));

import { answer, ask as send, finishCliCardChat } from "./card-chat";
import { savePreset } from "./presets";
import { MAX_NOTE, noteTexts } from "@/lib/coder/notes";
import { epicNoteTexts } from "./epic-notes";
import { ACTIVITY_EVENTS, activityOf } from "@/lib/domain/ticket-view";
import type { FormicEvent } from "@/lib/domain/events";
import { resetAgents } from "./registry";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import type { ColumnId } from "@/lib/domain/status";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, STAGING_PREFIX, resetVcs, setVcs } from "@/lib/vcs";
import { applyTransition } from "@/lib/board/service";
import { cardProblem } from "@/lib/domain/status";
import { completeCliRun } from "@/lib/runner/runner";
import { ANSWER_PATH, RUNNER_WORKFLOW_PATH, runnerWorkflow } from "@/lib/runner/workflow";

/**
 * A card's chat: the person talks to the agent they set for the card's
 * column, whatever it runs on. It knows the card and what is going on with
 * it, answers, and does what it is asked: moves, closes, redoes, rewrites.
 */

const PROJECT = "project_default";

/** A stand-in OpenAI-format provider that replies from a script. */
function fakeProvider(replies: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const next = replies.shift();
    if (!next) throw new Error("No scripted reply left.");
    return Response.json({
      choices: [{ message: next, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
  return sent;
}

function call(id: string, name: string, args: unknown) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function assignAgent(column: ColumnId, provider: "groq" | "claude-code" = "groq") {
  const preset = await savePreset({
    name: "agent",
    provider,
    model: provider === "groq" ? "llama-3.3-70b" : "",
    prompt: "",
    apiKey: provider === "groq" ? "gsk_test" : "sk-ant-oat01-plan",
  });
  await repository().setColumnAgent(PROJECT, column, preset.id);
  return preset;
}

async function seedTicket(): Promise<TicketDetail> {
  return (await seedTickets())[0];
}

/** T-1, and T-2 waiting on it. */
async function seedTickets(): Promise<[TicketDetail, TicketDetail]> {
  const repo = repository();
  const epic = await repo.createEpic({
    projectId: PROJECT,
    title: "An epic",
    rawRequest: "Do a thing",
    position: 1,
  });
  const made = await repo.createTickets([
    {
      epicId: epic.id,
      key: "T-1",
      title: "Do the thing",
      description: "Ship the export button.",
      acceptanceCriteria: ["It is done"],
      fileScope: ["src/lib/feature"],
      size: "M",
      storyPoints: 3,
      position: 1,
      dependsOnKeys: [],
    },
    {
      epicId: epic.id,
      key: "T-2",
      title: "Then the next thing",
      description: "Build on it.",
      acceptanceCriteria: ["It is done"],
      fileScope: ["src/lib/other"],
      size: "S",
      storyPoints: 1,
      position: 2,
      dependsOnKeys: ["T-1"],
    },
  ]);
  return [(await repo.ticketDetail(made[0]!.id))!, (await repo.ticketDetail(made[1]!.id))!];
}

async function installRunner(): Promise<void> {
  const base = (await projectFor(PROJECT)).baseBranch;
  await new MockVcsClient("acme/widgets").commitFile(base, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "install");
}

function lastDispatch() {
  return MockVcsClient.runner().dispatches.at(-1)!.inputs;
}

/** The CLI agent's run finished with this answer. */
async function answerFromActions(job: string, text: string) {
  await new MockVcsClient("acme/widgets").commitFile(`${STAGING_PREFIX}${job}`, ANSWER_PATH, text, "answer");
  await completeCliRun(PROJECT, { job, mode: "ask", conclusion: "success", url: null });
}

async function replies(ticketId: string) {
  const rows = await repository().ticketEvents(PROJECT, ticketId, [...ACTIVITY_EVENTS], 50);
  return rows
    .map((r) => activityOf(r.payload as FormicEvent, ticketId, r.seq, r.at.toISOString()))
    .filter((a) => a?.kind === "reply");
}

async function ask(cardKind: "epic" | "ticket", cardId: string, text: string) {
  const repo = repository();
  await repo.addCardChatMessage({ projectId: PROJECT, cardKind, cardId, role: "user", content: text });
  return repo.addCardChatMessage({
    projectId: PROJECT,
    cardKind,
    cardId,
    role: "assistant",
    content: "",
    status: "pending",
  });
}

async function reload(id: string) {
  return (await repository().cardChatMessage(id))!;
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

describe("a ticket's chat", () => {
  it("answers with the agent set for the ticket's column, knowing what is going on with it", async () => {
    const ticket = await seedTicket();
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, "src/lib/feature/index.ts", "export const x = 1;", "seed");
    await assignAgent("todo");
    await send(PROJECT, "ticket", ticket.id, "Use the existing helper.");
    await repository().clearCardChat(ticket.id);
    const sent = fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "read_file", { path: "src/lib/feature/index.ts" })] },
      { role: "assistant", content: "It exports a constant named x." },
    ]);
    const pending = await ask("ticket", ticket.id, "What does the file scope contain?");

    await answer("ticket", ticket.id, pending.id);

    expect(await reload(pending.id)).toMatchObject({ status: "done", content: "It exports a constant named x." });
    const system = String((sent[0]!.messages as Array<{ content: string }>)[0]!.content);
    expect(system).toContain("Architect Agent");
    expect(system).toContain("Ticket T-1: Do the thing");
    expect(system).toContain("Ship the export button.");
    expect(system).toContain("Column: To Do");
    expect(system).toContain("No agent is working on it right now.");
    expect(system).toContain("Person: Use the existing helper.");
  });

  it("says so when no agent is set for its column, and keeps the message as a note", async () => {
    const ticket = await seedTicket();
    const pending = await ask("ticket", ticket.id, "Split this?");
    await answer("ticket", ticket.id, pending.id);
    const done = await reload(pending.id);
    expect(done.status).toBe("done");
    expect(done.content).toContain("No agent is set for To Do");
    expect(done.content).toContain("kept as a note");
  });

  it("closes the ticket when the person says it is already done, and frees what waits on it", async () => {
    const [ticket, next] = await seedTickets();
    await assignAgent("todo");
    fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c1", "act", { action: { type: "close", summary: "Ran the beta loop by hand." } })],
      },
      { role: "assistant", content: "Closed it. T-2 can go ahead." },
    ]);
    const pending = await ask("ticket", ticket.id, "This has already been done.");

    await answer("ticket", ticket.id, pending.id);

    const closed = (await repository().ticketDetail(ticket.id))!;
    expect(closed.status).toBe("merged");
    expect(closed.summary).toBe("Closed by you: Ran the beta loop by hand.");
    expect((await repository().ticketDetail(next.id))!.status).toBe("ready");
    expect(await reload(pending.id)).toMatchObject({ status: "done", content: "Closed it. T-2 can go ahead." });
    expect(await replies(ticket.id)).toMatchObject([{ agent: "Architect Agent", text: "Closed it. T-2 can go ahead." }]);
  });

  it("puts what the person found under Results", async () => {
    const ticket = await seedTicket();
    await assignAgent("todo");
    fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c1", "act", { action: { type: "edit_ticket", results: "Merged PR #12 on the real repo." } })],
      },
      { role: "assistant", content: "Added it." },
    ]);
    const pending = await ask("ticket", ticket.id, "It worked: PR #12 merged.");
    await answer("ticket", ticket.id, pending.id);

    expect((await repository().ticketDetail(ticket.id))!.description).toBe(
      "Ship the export button.\n\n### Results\nMerged PR #12 on the real repo.",
    );
  });

  it("moves the ticket when asked, starting whatever the column starts", async () => {
    const ticket = await seedTicket();
    await assignAgent("todo");
    fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "act", { action: { type: "move", to: "in_progress" } })] },
      { role: "assistant", content: "On its way." },
    ]);
    const pending = await ask("ticket", ticket.id, "Start it.");
    await answer("ticket", ticket.id, pending.id);

    expect((await repository().ticketDetail(ticket.id))!.status).toBe("running");
    expect(launched).toEqual([`coder agent for ${ticket.key}`]);
  });

  it("leaves the ticket where it was when it cannot go where it was asked, and says why", async () => {
    const ticket = await seedTicket();
    await assignAgent("todo");
    const sent = fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "act", { action: { type: "move", to: "in_review" } })] },
      { role: "assistant", content: "It has no pull request yet." },
    ]);
    const pending = await ask("ticket", ticket.id, "Send it to review.");
    await answer("ticket", ticket.id, pending.id);

    const card = (await repository().cardById(ticket.id))!;
    expect(card.misplacedIn ?? null).toBeNull();
    expect(card.status).toBe("ready");
    const toolResult = (sent[1]!.messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("Could not move T-1");
    expect(toolResult?.content).not.toContain("Drag it back");
  });

  it("redoes the work its way: stops the agent at it, then starts the Coder Agent with the instruction", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, { status: "running", runnerJob: `${ticket.id}--abc` });
    await assignAgent("in_progress");
    fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c1", "act", { action: { type: "redo", instruction: "Use the existing helper instead." } })],
      },
      { role: "assistant", content: "Starting over with the helper." },
    ]);
    const pending = await ask("ticket", ticket.id, "Stop, and use the existing helper instead.");
    await answer("ticket", ticket.id, pending.id);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.runnerJob).toBeNull();
    expect(launched).toEqual([`coder agent for ${ticket.key}, from its chat`]);
  });

  it("is answered by a CLI agent from GitHub Actions, which can act too", async () => {
    const ticket = await seedTicket();
    await assignAgent("todo", "claude-code");
    await installRunner();
    const pending = await ask("ticket", ticket.id, "This has already been done.");

    await answer("ticket", ticket.id, pending.id);

    const inputs = lastDispatch();
    expect(inputs).toMatchObject({ mode: "ask", ticket: "T-1", cli: "claude" });
    expect(inputs.prompt).toContain("Ticket T-1: Do the thing");
    expect(inputs.prompt).toContain("This has already been done.");
    expect(inputs.prompt).toContain('"actions"');
    const waiting = await reload(pending.id);
    expect(waiting).toMatchObject({ status: "pending", runnerJob: inputs.job });
    expect(waiting.content).toContain("reading this in GitHub Actions");
    expect(await replies(ticket.id)).toMatchObject([{ agent: null, text: expect.stringContaining("GitHub Actions") }]);

    await answerFromActions(
      inputs.job!,
      JSON.stringify({ reply: "Closing it.", actions: [{ type: "close", summary: "Done by hand." }] }),
    );

    expect((await repository().ticketDetail(ticket.id))!.status).toBe("merged");
    const done = await reload(pending.id);
    expect(done.status).toBe("done");
    expect(done.content).toContain("Closing it.");
    expect(done.content).toContain("Closed T-1");
    expect((await replies(ticket.id)).at(-1)).toMatchObject({ agent: "Architect Agent" });
  });

  it("says why a CLI agent's run failed", async () => {
    const ticket = await seedTicket();
    await assignAgent("todo", "claude-code");
    await installRunner();
    const pending = await ask("ticket", ticket.id, "Split this?");
    await answer("ticket", ticket.id, pending.id);

    await completeCliRun(PROJECT, { job: lastDispatch().job!, mode: "ask", conclusion: "cancelled", url: null });

    expect(await reload(pending.id)).toMatchObject({ status: "failed", content: expect.stringContaining("cancelled") });
  });

  it("sets aside an action from a CLI agent that Formic cannot use, and says so", async () => {
    const ticket = await seedTicket();
    const pending = await ask("ticket", ticket.id, "Close it.");
    await finishCliCardChat(pending.id, JSON.stringify({ reply: "Closing.", actions: [{ type: "explode" }] }));
    expect((await repository().ticketDetail(ticket.id))!.status).toBe("ready");
    expect((await reload(pending.id)).content).toContain("could not use one of the agent's actions");
  });

  it("passes every message on to the agent as a note", async () => {
    const ticket = await seedTicket();
    const long = "x".repeat(MAX_NOTE);
    await send(PROJECT, "ticket", ticket.id, "Use the existing helper.");
    await repository().clearCardChat(ticket.id);
    await send(PROJECT, "ticket", ticket.id, long);
    expect(await noteTexts(PROJECT, ticket.id)).toEqual(["Use the existing helper.", long]);
  });
});

describe("a ticket that is work for a person", () => {
  it("shows what the person has to do, and no agent starts it", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, { needsHuman: "Run the loop on production" });
    const card = (await repository().cardById(ticket.id))!;
    expect(cardProblem(card)).toContain("Run the loop on production.");

    const moved = await applyTransition(PROJECT, {
      cardId: ticket.id,
      kind: "ticket",
      from: "todo",
      to: "in_progress",
      position: 1,
      actor: "user",
    });
    expect(moved).toMatchObject({ ok: true, problem: expect.stringContaining("is for you, not an agent") });
    expect(launched).toEqual([]);
  });

  it("stops needing the person once closed", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, { needsHuman: "Run the loop on production" });
    await finishCliCardChat(
      (await ask("ticket", ticket.id, "Done.")).id,
      JSON.stringify({ reply: "Closing.", actions: [{ type: "close", summary: "Ran it." }] }),
    );
    const card = (await repository().cardById(ticket.id))!;
    expect(card.needsHuman ?? null).toBeNull();
    expect(cardProblem(card)).toBeNull();
  });
});

describe("an Epic's chat", () => {
  it("answers with the Product Agent, and includes the raw request", async () => {
    const repo = repository();
    const epic = await repo.createEpic({
      projectId: PROJECT,
      title: "Export",
      rawRequest: "Let people export the board as CSV.",
      position: 1,
    });
    await assignAgent("backlog");
    const sent = fakeProvider([{ role: "assistant", content: "This needs a PRD; it touches several files." }]);
    const pending = await ask("epic", epic.id, "Does this need a PRD?");

    await answer("epic", epic.id, pending.id);

    expect(await reload(pending.id)).toMatchObject({
      status: "done",
      content: "This needs a PRD; it touches several files.",
    });
    const system = String((sent[0]!.messages as Array<{ content: string }>)[0]!.content);
    expect(system).toContain("Product Agent");
    expect(system).toContain("Let people export the board as CSV.");
  });

  it("does not leave a ticket note, since no agent works an Epic that way", async () => {
    const epic = await repository().createEpic({
      projectId: PROJECT,
      title: "Export",
      rawRequest: "Export as CSV.",
      position: 1,
    });
    await send(PROJECT, "epic", epic.id, "Keep it small.");
    expect(await noteTexts(PROJECT, epic.id)).toEqual([]);
    expect(await epicNoteTexts(PROJECT, epic.id)).toEqual(["Keep it small."]);
  });

  const PRD = {
    summary: "s",
    problem: "p",
    scope: ["x"],
    outOfScope: [],
    technicalContext: [],
    userStories: [],
    successCriteria: ["y"],
  };

  /** An Epic already broken down once, sitting idle in To Do. */
  async function seedDecomposedEpic() {
    const repo = repository();
    const epic = await repo.createEpic({
      projectId: PROJECT,
      title: "Export",
      rawRequest: "Export as CSV.",
      position: 1,
    });
    await repo.setEpicPrd(epic.id, PRD, true);
    await repo.move({ cardId: epic.id, kind: "epic", status: "ready", stalledIn: null, position: 1 });
    return epic;
  }

  it("breaks an Epic down again when asked to change it", async () => {
    const epic = await seedDecomposedEpic();
    await assignAgent("todo");
    fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "act", { action: { type: "redo", instruction: "Split the 13-pointer." } })] },
      { role: "assistant", content: "Breaking it down again." },
    ]);
    const pending = await ask("epic", epic.id, "Split the 13-pointer.");

    await answer("epic", epic.id, pending.id);

    expect(await reload(pending.id)).toMatchObject({ status: "done", content: "Breaking it down again." });
    expect(launched).toEqual([`architect agent for ${epic.key}, from its chat`]);
  });

  it("does not start a second breakdown while the Architect Agent is already working", async () => {
    const epic = await seedDecomposedEpic();
    await assignAgent("todo");
    await repository().setEpicRunnerJob(epic.id, "run-123");
    const sent = fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "act", { action: { type: "redo", instruction: "Split it." } })] },
      { role: "assistant", content: "It is already on it." },
    ]);
    const pending = await ask("epic", epic.id, "Split the 13-pointer.");

    await answer("epic", epic.id, pending.id);

    const toolResult = (sent[1]!.messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
    expect(toolResult?.content).toContain("already breaking this Epic down");
    expect(launched).toEqual([]);
  });
});
