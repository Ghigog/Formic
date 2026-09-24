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

import { answer, ask as send } from "./card-chat";
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
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";

/**
 * A card's chat: the agent that runs its column now answers with the card's
 * own detail as context, and can read the repository but nothing else.
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
  const repo = repository();
  const epic = await repo.createEpic({
    projectId: PROJECT,
    title: "An epic",
    rawRequest: "Do a thing",
    position: 1,
  });
  const [ticket] = await repo.createTickets([
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
  ]);
  return (await repo.ticketDetail(ticket!.id))!;
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
  it("answers with the Architect Agent, the ticket's own column", async () => {
    const ticket = await seedTicket();
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, "src/lib/feature/index.ts", "export const x = 1;", "seed");
    await assignAgent("todo");
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
  });

  it("says so when no agent is set for its column, and passes the message on", async () => {
    const ticket = await seedTicket();
    const pending = await ask("ticket", ticket.id, "Split this?");
    await answer("ticket", ticket.id, pending.id);
    const done = await reload(pending.id);
    expect(done.status).toBe("done");
    expect(done.content).toContain("No agent is set for To Do");
    expect(done.content).toContain("passed on to the agent working this ticket");
  });

  it("adds nothing while a CLI agent works the ticket: it answers in the ticket's log", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, { status: "running" });
    await assignAgent("in_progress", "claude-code");
    const pending = await ask("ticket", ticket.id, "How's it going?");
    await answer("ticket", ticket.id, pending.id);
    expect(await reload(pending.id)).toMatchObject({ status: "done", content: "" });
  });

  it("says when a CLI agent will read it, when nothing is working the ticket", async () => {
    const ticket = await seedTicket();
    await assignAgent("todo", "claude-code");
    const pending = await ask("ticket", ticket.id, "Split this?");
    await answer("ticket", ticket.id, pending.id);
    const done = await reload(pending.id);
    expect(done.status).toBe("done");
    expect(done.content).toContain("reads this when it next runs");
    expect(done.content).not.toContain("cannot reply");
  });

  it("puts the answer in the ticket's log, under whoever gave it", async () => {
    const ticket = await seedTicket();
    await assignAgent("todo");
    fakeProvider([{ role: "assistant", content: "Two files, one test." }]);
    const pending = await ask("ticket", ticket.id, "How big is this?");
    await answer("ticket", ticket.id, pending.id);

    await assignAgent("todo", "claude-code");
    const idle = await ask("ticket", ticket.id, "Split this?");
    await answer("ticket", ticket.id, idle.id);

    const rows = await repository().ticketEvents(PROJECT, ticket.id, [...ACTIVITY_EVENTS], 50);
    const replies = rows
      .map((r) => activityOf(r.payload as FormicEvent, ticket.id, r.seq, r.at.toISOString()))
      .filter((a) => a?.kind === "reply");
    expect(replies).toMatchObject([
      { agent: "Architect Agent", text: "Two files, one test." },
      { agent: null, text: expect.stringContaining("reads this when it next runs") },
    ]);
  });

  it("logs nothing while a CLI agent works the ticket: its own answer is in the log", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, { status: "running" });
    await assignAgent("in_progress", "claude-code");
    const pending = await ask("ticket", ticket.id, "How's it going?");
    await answer("ticket", ticket.id, pending.id);
    const rows = await repository().ticketEvents(PROJECT, ticket.id, ["ticket.reply"], 50);
    expect(rows).toHaveLength(0);
  });

  it("passes every message on to the agent as a note", async () => {
    const ticket = await seedTicket();
    const long = "x".repeat(MAX_NOTE);
    await send(PROJECT, "ticket", ticket.id, "Use the existing helper.");
    await repository().clearCardChat(ticket.id);
    await send(PROJECT, "ticket", ticket.id, long);
    expect(await noteTexts(PROJECT, ticket.id)).toEqual(["Use the existing helper.", long]);
  });

  it("starts the Coder Agent again when its ticket is idle in In Progress", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, {
      status: "blocked",
      stalledIn: "in_progress",
      blockedReason: "Out of scope",
    });
    await assignAgent("in_progress", "claude-code");
    const pending = await ask("ticket", ticket.id, "Only touch the button component.");
    await answer("ticket", ticket.id, pending.id);

    expect(await reload(pending.id)).toMatchObject({
      status: "done",
      content: "Starting the Coder Agent again with your note.",
    });
    expect(launched).toEqual([`coder agent for ${ticket.key}`]);
  });

  it("does not start a new run while the ticket is already running", async () => {
    const ticket = await seedTicket();
    await repository().updateTicket(ticket.id, { status: "running" });
    await assignAgent("in_progress", "claude-code");
    const pending = await ask("ticket", ticket.id, "Only touch the button component.");
    await answer("ticket", ticket.id, pending.id);

    expect(launched).toEqual([]);
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

  it("breaks an Epic down again when idle in To Do, instead of just answering", async () => {
    const epic = await seedDecomposedEpic();
    await assignAgent("todo", "claude-code");
    const pending = await ask("epic", epic.id, "Split the 13-pointer.");

    await answer("epic", epic.id, pending.id);

    expect(await reload(pending.id)).toMatchObject({
      status: "done",
      content: "Breaking it down again with your note. Tickets already started stay; the rest follow it.",
    });
    expect(launched).toEqual([`architect agent for ${epic.key}`]);
  });

  it("does not start a second breakdown while the Architect Agent is already working", async () => {
    const epic = await seedDecomposedEpic();
    await assignAgent("todo", "claude-code");
    await repository().setEpicRunnerJob(epic.id, "run-123");
    const pending = await ask("epic", epic.id, "Split the 13-pointer.");

    await answer("epic", epic.id, pending.id);

    expect(await reload(pending.id)).toMatchObject({
      status: "done",
      content:
        "The Architect Agent is already working on this Epic. Your note will be included in its next run.",
    });
    expect(launched).toEqual([]);
  });
});
