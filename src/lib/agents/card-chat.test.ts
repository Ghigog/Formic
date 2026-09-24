import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answer } from "./card-chat";
import { savePreset } from "./presets";
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

  it("says so when no agent is set for its column", async () => {
    const ticket = await seedTicket();
    const pending = await ask("ticket", ticket.id, "Split this?");
    await answer("ticket", ticket.id, pending.id);
    const done = await reload(pending.id);
    expect(done.status).toBe("failed");
    expect(done.content).toContain("No agent is set for To Do");
  });

  it("says a CLI agent cannot chat live", async () => {
    const ticket = await seedTicket();
    await assignAgent("todo", "claude-code");
    const pending = await ask("ticket", ticket.id, "Split this?");
    await answer("ticket", ticket.id, pending.id);
    const done = await reload(pending.id);
    expect(done.status).toBe("failed");
    expect(done.content).toContain("runs in GitHub Actions and cannot chat live");
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
});
