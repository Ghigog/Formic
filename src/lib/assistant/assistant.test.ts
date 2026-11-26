import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launched = vi.hoisted(() => [] as Array<{ work: () => Promise<void>; label: string }>);

// `launch` only records the work, so a test starts the next queued reply itself.
vi.mock("@/lib/agents/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/pipeline")>()),
  launch: (work: () => Promise<void>, label: string) => {
    launched.push({ work, label });
  },
}));

import { answer, cancelPending, PLAYTEST_RULE, sessionSystemPrompt, finishCliAnswer, history, MAX_ANSWER_MS } from "./turn";
import { applyAction, ASSISTANT_BRANCH_PREFIX, checkAction } from "./actions";
import { savePreset } from "@/lib/agents/presets";
import { resetAgents } from "@/lib/agents/registry";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { questionReason } from "@/lib/domain/question";
import { epicNoteTexts } from "@/lib/agents/epic-notes";
import { collectCliRuns, completeCliRun } from "@/lib/runner/runner";
import { ANSWER_PATH, RUNNER_WORKFLOW_PATH, runTitle, runnerWorkflow } from "@/lib/runner/workflow";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, STAGING_PREFIX, resetVcs, setVcs } from "@/lib/vcs";

/**
 * The board's assistant: reads the repository, answers, and proposes board
 * changes that only happen once the person approves them.
 */

const PROJECT = "project_default";

const TICKETS = [
  {
    key: "T-1",
    title: "Export endpoint",
    userStory: { as: "a board owner", want: "Serve the CSV", soThat: "my work moves on" },
    requirements: ["Covered by a test"],
    acceptanceCriteria: [{ given: "the board", when: "it runs", then: "It downloads" }],
    fileScope: ["src/app/api/export"],
    size: "S",
    storyPoints: 3,
    type: "task",
    dependsOn: [],
  },
  {
    key: "T-2",
    title: "Export button",
    userStory: { as: "a board owner", want: "A button that calls it", soThat: "my work moves on" },
    requirements: ["Covered by a test"],
    acceptanceCriteria: [{ given: "the board", when: "it runs", then: "It is on the board" }],
    fileScope: ["src/components/export"],
    size: "S",
    storyPoints: 3,
    type: "task",
    dependsOn: ["T-1"],
  },
];

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

async function useAgent(provider: "groq" | "claude-code") {
  const preset = await savePreset({
    name: "pm",
    provider,
    model: provider === "groq" ? "llama-3.3-70b" : "",
    prompt: "",
    apiKey: provider === "groq" ? "gsk_test" : "sk-ant-oat01-plan",
  });
  await repository().setAssistantAgent(PROJECT, preset.id);
}

async function ask(text: string) {
  const repo = repository();
  await repo.addAssistantMessage({ projectId: PROJECT, role: "user", content: text });
  return repo.addAssistantMessage({ projectId: PROJECT, role: "assistant", content: "", status: "pending" });
}

async function reload(id: string) {
  return (await repository().assistantMessage(id))!;
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

describe("the assistant", () => {
  it("reads the repository to answer a question", async () => {
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, "docs/tickets.md", "1. Export endpoint\n2. Export button", "x");
    await useAgent("groq");
    const sent = fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "list_files", { prefix: "docs" })] },
      { role: "assistant", content: null, tool_calls: [call("c2", "read_file", { path: "docs/tickets.md" })] },
      { role: "assistant", content: "There are two tickets: an endpoint and a button." },
    ]);
    const pending = await ask("What is in the ticket list?");

    await answer(PROJECT, pending.id);

    const done = await reload(pending.id);
    expect(done).toMatchObject({ status: "done", content: "There are two tickets: an endpoint and a button." });
    const toolResults = (sent[2]!.messages as Array<{ role: string; content: string }>).filter(
      (m) => m.role === "tool",
    );
    expect(toolResults[0]!.content).toBe("docs/tickets.md");
    expect(toolResults[1]!.content).toContain("Export button");
    const system = String((sent[0]!.messages as Array<{ content: string }>)[0]!.content);
    expect(system).toContain(`base branch ${base}`);
    expect(system).toContain("The board right now:");
  });

  it("stops when its clock runs out, finishing done with what it read", async () => {
    const base = (await projectFor(PROJECT)).baseBranch;
    await new MockVcsClient("acme/widgets").commitFile(base, "docs/tickets.md", "1. Export endpoint", "x");
    await useAgent("groq");
    // A provider slow enough that one round outlives the whole budget.
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => {
      vi.setSystemTime(Date.now() + MAX_ANSWER_MS);
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [call("c1", "read_file", { path: "docs/tickets.md" })],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    });
    const pending = await ask("What is in the ticket list?");

    try {
      await answer(PROJECT, pending.id);
    } finally {
      vi.useRealTimers();
    }

    expect(await reload(pending.id)).toMatchObject({
      status: "done",
      content: expect.stringContaining(
        "I ran out of time (4 minute limit) before I reached an answer. I read 1 file: docs/tickets.md.",
      ),
    });
  });

  it("proposes board changes without making them", async () => {
    await useAgent("groq");
    const before = (await repository().boardCards(PROJECT)).length;
    fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("c1", "propose", {
            summary: "Add the export tickets",
            action: { type: "create_epic_with_tickets", title: "Export", summary: "CSV export", tickets: TICKETS },
          }),
        ],
      },
      { role: "assistant", content: "I proposed an Epic with two tickets." },
    ]);
    const pending = await ask("Turn the list into tickets");

    await answer(PROJECT, pending.id);

    const done = await reload(pending.id);
    expect(done.proposals).toHaveLength(1);
    expect(done.proposals[0]).toMatchObject({ summary: "Add the export tickets", state: "proposed" });
    expect(await repository().boardCards(PROJECT)).toHaveLength(before);
  });

  it("hands an unsafe ticket graph back to the model instead of proposing it", async () => {
    await useAgent("groq");
    const clash = TICKETS.map((t) => ({ ...t, fileScope: ["src/app"], dependsOn: [] }));
    const sent = fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("c1", "propose", {
            summary: "Add them",
            action: { type: "create_epic_with_tickets", title: "Export", summary: "s", tickets: clash },
          }),
        ],
      },
      { role: "assistant", content: "Those clash; let me fix them." },
    ]);
    const pending = await ask("Add these");

    await answer(PROJECT, pending.id);

    expect((await reload(pending.id)).proposals).toHaveLength(0);
    const result = (sent[1]!.messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
    expect(result!.content).toContain("not safe to run");
  });

  it("says so when no agent is picked", async () => {
    const pending = await ask("Hello?");
    await answer(PROJECT, pending.id);
    expect(await reload(pending.id)).toMatchObject({ status: "failed" });
    expect((await reload(pending.id)).content).toContain("No agent is set for the assistant");
  });
});

async function askSpeakers(text: string, speakers: string[]) {
  const repo = repository();
  await repo.addAssistantMessage({ projectId: PROJECT, role: "user", content: text });
  const replies = [];
  for (const speaker of speakers) {
    replies.push(await repo.addAssistantMessage({ projectId: PROJECT, role: "assistant", content: "", status: "pending", speaker }));
  }
  return replies;
}

async function columnAgent(column: "in_review" | "todo") {
  const preset = await savePreset({ name: "col", provider: "groq", model: "llama-3.3-70b", prompt: "", apiKey: "gsk_test" });
  await repository().setColumnAgent(PROJECT, column, preset.id);
}

async function seedReviewTicket() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "x", position: 1 });
  const [made] = await repo.createTickets([
    { epicId: epic.id, key: "T-1", title: "In review", description: "d", acceptanceCriteria: ["ok"], fileScope: ["src/a"], size: "S", storyPoints: 1, position: 1, dependsOnKeys: [] },
  ]);
  await repo.updateTicket(made!.id, { status: "review" });
  return made!;
}

describe("the chat's queue", () => {
  it("starts the next pending reply when one finishes, fails or is stopped, in order", async () => {
    await useAgent("groq");
    fakeProvider([{ role: "assistant", content: "First." }]);
    const [first, second, third] = await askSpeakers("hi", ["assistant", "assistant", "assistant"]);

    await answer(PROJECT, first!.id);
    expect(launched.map((l) => l.label)).toEqual([`assistant answer ${second!.id}`]);

    await cancelPending(PROJECT, second!.id);
    expect(await reload(second!.id)).toMatchObject({ status: "failed", content: "Stopped." });
    expect(launched.map((l) => l.label)).toEqual([`assistant answer ${second!.id}`, `assistant answer ${third!.id}`]);
  });

  it("stops a queued reply without starting the running one again", async () => {
    await useAgent("groq");
    const [first, second] = await askSpeakers("hi", ["assistant", "assistant"]);

    await cancelPending(PROJECT, second!.id);
    expect(await reload(second!.id)).toMatchObject({ status: "failed", content: "Stopped." });
    expect(await reload(first!.id)).toMatchObject({ status: "pending" });
    expect(launched).toEqual([]);
  });


  it("shows each reply only the conversation up to its own message", async () => {
    await useAgent("groq");
    const sent = fakeProvider([{ role: "assistant", content: "Answer." }]);
    const [first] = await askSpeakers("first question", ["assistant"]);
    await askSpeakers("second question", ["assistant"]);

    await answer(PROJECT, first!.id);

    const said = JSON.stringify(sent[0]!.messages);
    expect(said).toContain("first question");
    expect(said).not.toContain("second question");
  });
});

describe("a column agent in the chat", () => {
  it("replies as itself with its card actions, and a move to Done is a proposal, not a merge", async () => {
    const ticket = await seedReviewTicket();
    await columnAgent("in_review");
    fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "act_on_card", { key: "T-1", action: { type: "move", to: "done" } })] },
      { role: "assistant", content: "I proposed moving it." },
    ]);
    const [reply] = await askSpeakers("Reviewer, ship T-1", ["reviewer"]);

    await answer(PROJECT, reply!.id);

    const done = await reload(reply!.id);
    expect(done).toMatchObject({ speaker: "reviewer", status: "done", content: "I proposed moving it." });
    expect(done.proposals).toEqual([
      expect.objectContaining({ state: "proposed", action: { type: "move_card", key: "T-1", to: "done" } }),
    ]);
    expect((await repository().ticketDetail(ticket.id))!.status).not.toBe("merged");
  });

  it("acts at once on a card in its column, and refuses one in another", async () => {
    await seedReviewTicket();
    await columnAgent("todo");
    fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "act_on_card", { key: "T-1", action: { type: "stop" } })] },
      { role: "assistant", content: "Not mine." },
    ]);
    const [reply] = await askSpeakers("Architect, stop T-1", ["architect"]);

    await answer(PROJECT, reply!.id);

    expect(await reload(reply!.id)).toMatchObject({ speaker: "architect", status: "done", content: "Not mine." });
  });
});

describe("a Sentinel in the chat", () => {
  it("says so when it has no audit yet, and starts none", async () => {
    await useAgent("groq");
    const [reply] = await askSpeakers("Tester, how are the tests?", ["sentinel:tester"]);

    await answer(PROJECT, reply!.id);

    expect(await reload(reply!.id)).toMatchObject({ speaker: "sentinel:tester", status: "done" });
    expect((await reload(reply!.id)).content).toContain("not audited");
    expect(await repository().auditsFor(PROJECT)).toEqual([]);
  });
});

describe("the PM, relaying questions", () => {
  it("is briefed with the questions cards wait on and the person's own words, and passes their answer back", async () => {
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "Bells", rawRequest: "Ring the bell by swinging it.", position: 1 });
    await repo.stallEpic(epic.id, {
      status: "blocked",
      stalledIn: "backlog",
      stage: 2,
      reason: questionReason("The Product Agent", [{ question: "Should a tap ever ring it?", why: "Misclicks." }]),
    });
    await useAgent("groq");
    const sent = fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "answer_question", { key: epic.key, answer: "Never, only a swing." })] },
      { role: "assistant", content: "Passed on: only a swing rings it." },
    ]);
    const pending = await ask("Never, only a swing.");

    await answer(PROJECT, pending.id);

    const system = String((sent[0]!.messages as Array<{ content: string }>)[0]!.content);
    expect(system).toContain("You are the PM");
    expect(system).toContain("Should a tap ever ring it?");
    expect(system).toContain("ask a short follow-up instead and call answer_question once the answers are complete");
    const tool = (sent[0]!.tools as Array<{ function: { name: string; description: string } }>).find((t) => t.function.name === "answer_question");
    expect(tool?.function.description).toContain("ask the person a short follow-up instead");
    expect(system).toContain('"Ring the bell by swinging it."');
    expect(await epicNoteTexts(PROJECT, epic.id)).toEqual([
      "You asked the person:\nShould a tap ever ring it?\n   Why: Misclicks.\n\nThey answered: Never, only a swing.",
    ]);
    expect((await reload(pending.id)).content).toBe("Passed on: only a swing rings it.");
  });
});

describe("a turn's edges", () => {
  it("hands a bad tool call back to the model as an error, not a crash", async () => {
    await useAgent("groq");
    const sent = fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("c1", "read_file", { path: "/missing.md" }),
          call("c2", "list_files", { prefix: "/nowhere/" }),
          call("c3", "delete_repo", {}),
          call("c4", "read_file", {}),
        ],
      },
      { role: "assistant", content: "I could not find it." },
    ]);
    const pending = await ask("What is in missing.md?");

    await answer(PROJECT, pending.id);

    expect(await reload(pending.id)).toMatchObject({ status: "done", content: "I could not find it." });
    const results = (sent[1]!.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === "tool")
      .map((m) => m.content);
    expect(results[0]).toBe("Error: /missing.md does not exist on main.");
    expect(results[1]).toBe("No files there.");
    expect(results[2]).toBe("Error: There is no tool called delete_repo.");
    expect(results[3]).toMatch(/path/);
  });

  it("fails with what it read and its last error when it runs out of rounds", async () => {
    await useAgent("groq");
    fakeProvider(
      Array.from({ length: 16 }, (_, i) => ({
        role: "assistant",
        content: null,
        tool_calls: [call(`c${i}`, "read_file", { path: "nope.md" })],
      })),
    );
    const pending = await ask("Keep looking.");

    await answer(PROJECT, pending.id);

    const done = await reload(pending.id);
    expect(done.status).toBe("failed");
    expect(done.content).toContain("nope.md does not exist");
  });

  it("tells the model what the person decided about its earlier proposals", async () => {
    await useAgent("groq");
    const repo = repository();
    await repo.addAssistantMessage({ projectId: PROJECT, role: "user", content: "Plan it." });
    const earlier = await repo.addAssistantMessage({ projectId: PROJECT, role: "assistant", content: "", status: "pending" });
    await repo.updateAssistantMessage(earlier.id, {
      content: "Here is a plan.",
      status: "done",
      proposals: [
        { summary: "Add the export Epic", action: { type: "create_backlog_item", title: "x", description: "y" }, state: "dismissed" },
      ] as never,
    });
    const sent = fakeProvider([{ role: "assistant", content: "Understood." }]);
    const pending = await ask("Why not?");

    await answer(PROJECT, pending.id);

    const history = (sent[0]!.messages as Array<{ role: string; content: string }>).map((m) => m.content);
    expect(history).toContain("Here is a plan.\n[Proposed: Add the export Epic. The person dismissed it.]");
  });

  it("gives the model Formic's notices as board events, never as its own words", async () => {
    await useAgent("groq");
    const repo = repository();
    await repo.addAssistantMessage({ projectId: PROJECT, role: "user", content: "How is T-1?" });
    await repo.addAssistantMessage({ projectId: PROJECT, role: "assistant", content: "Still in review." });
    await repo.addAssistantMessage({ projectId: PROJECT, role: "assistant", kind: "notice", content: "Opened pull request #726" });
    const sent = fakeProvider([{ role: "assistant", content: "Noted." }]);
    const pending = await ask("And now?");

    await answer(PROJECT, pending.id);

    const said = sent[0]!.messages as Array<{ role: string; content: string }>;
    const withNotice = said.filter((m) => m.content.includes("Opened pull request #726"));
    expect(withNotice).toHaveLength(1);
    expect(withNotice[0]).toMatchObject({ role: "user" });
    expect(withNotice[0]!.content).toContain("[Board: Opened pull request #726]");
    // Joined with the person's next message: no provider sees two user turns in a row for it.
    expect(withNotice[0]!.content).toContain("And now?");
    expect(said.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["Still in review."]);
  });

  it("shows a reply the conversation with notices moved above the question they landed after", async () => {
    await useAgent("groq");
    const repo = repository();
    await repo.addAssistantMessage({ projectId: PROJECT, role: "user", content: "Give me the answer first." });
    await repo.addAssistantMessage({ projectId: PROJECT, role: "assistant", kind: "notice", content: "EPIC-122-T3 added" });
    const pending = await repo.addAssistantMessage({ projectId: PROJECT, role: "assistant", content: "", status: "pending" });
    const sent = fakeProvider([{ role: "assistant", content: "Here it is." }]);

    await answer(PROJECT, pending.id);

    const said = sent[0]!.messages as Array<{ role: string; content: string }>;
    // The person's question is the last thing it reads, not the notice.
    expect(said.at(-1)!.content).toMatch(/\[Board: EPIC-122-T3 added\]\n\nGive me the answer first\.$/);
  });

  it("turns a provider failure into a failed message the person can read", async () => {
    await useAgent("groq");
    vi.stubGlobal("fetch", async () => {
      throw new Error("provider is down");
    });
    const pending = await ask("Hello?");

    await answer(PROJECT, pending.id);

    const done = await reload(pending.id);
    expect(done.status).toBe("failed");
    expect(done.content).toMatch(/provider is down/);
  });

  it("shows a CLI run's failure, or its silence, as the reply", async () => {
    const failed = await ask("One?");
    const silent = await ask("Two?");

    await finishCliAnswer(failed.id, null, "The run was cancelled.");
    await finishCliAnswer(silent.id, "   ");

    expect(await reload(failed.id)).toMatchObject({ status: "failed", content: "The run was cancelled." });
    expect(await reload(silent.id)).toMatchObject({ status: "failed", content: "The agent finished without an answer." });
  });
});

describe("applying an approved proposal", () => {
  it("puts a planned Epic and its tickets straight into To Do", async () => {
    const checked = checkAction({
      type: "create_epic_with_tickets",
      title: "Export",
      summary: "CSV export",
      tickets: TICKETS,
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const before = new Set((await repository().boardCards(PROJECT)).map((c) => c.id));
    const said = await applyAction(PROJECT, checked.action);

    const cards = (await repository().boardCards(PROJECT)).filter((c) => !before.has(c.id));
    const epic = cards.find((c) => c.kind === "epic")!;
    expect(epic.status).toBe("ready");
    const tickets = cards.filter((c) => c.kind === "ticket");
    expect(tickets.every((t) => t.epicId === epic.id)).toBe(true);
    expect(tickets.map((t) => t.key).sort()).toEqual([`${epic.key}-T1`, `${epic.key}-T2`]);
    expect(said).toContain("2 tickets");
  });

  it("copies a playtest note's screenshot onto the Backlog item, and ignores one that is not on a note", async () => {
    const repo = repository();
    const upload = (requestId: string) =>
      repo.createAttachment({ projectId: PROJECT, requestId, filename: "shot.png", mimeType: "image/png", kind: "image", size: 2, bytes: new Uint8Array([7, 8]) });
    const shot = await upload("playtest-note-1");
    const stray = await upload("playtest-stray");
    const note = await repo.addAssistantMessage({ projectId: PROJECT, role: "user", content: "Score never resets", playtestId: "pt1" });
    await repo.claimAttachments("playtest-note-1", { assistantMessageId: note.id });

    const checked = checkAction({ type: "create_backlog_item", request: "Reset the score", screenshots: [shot.id, stray.id] });
    if (!checked.ok) throw new Error(checked.problem);
    const before = new Set((await repo.boardCards(PROJECT)).map((c) => c.id));
    await applyAction(PROJECT, checked.action);
    const epic = (await repo.boardCards(PROJECT)).find((c) => !before.has(c.id) && c.kind === "epic")!;

    const onEpic = await repo.attachmentsFor({ epicId: epic.id });
    expect(onEpic).toHaveLength(1);
    expect(onEpic[0]).toMatchObject({ filename: "shot.png", mimeType: "image/png", kind: "image" });
    expect((await repo.attachmentContent(onEpic[0]!.id))?.bytes).toEqual(new Uint8Array([7, 8]));
    // The note keeps its own picture.
    expect((await repo.attachmentsFor({ assistantMessageId: note.id })).map((a) => a.id)).toEqual([shot.id]);
  });

  it("accepts create_todo_item and files a To Do ticket carrying the note's screenshot", async () => {
    const repo = repository();
    const shot = await repo.createAttachment({ projectId: PROJECT, requestId: "playtest-note-2", filename: "shot.png", mimeType: "image/png", kind: "image", size: 2, bytes: new Uint8Array([7, 8]) });
    const note = await repo.addAssistantMessage({ projectId: PROJECT, role: "user", content: "Night pick-up is off", playtestId: "pt2" });
    await repo.claimAttachments("playtest-note-2", { assistantMessageId: note.id });

    const checked = checkAction({ type: "create_todo_item", request: "Night pick-up should work by nearness", screenshots: [shot.id] });
    if (!checked.ok) throw new Error(checked.problem);
    const before = new Set((await repo.boardCards(PROJECT)).map((c) => c.id));
    const said = await applyAction(PROJECT, checked.action);
    const added = (await repo.boardCards(PROJECT)).filter((c) => !before.has(c.id));
    const ticket = added.find((c) => c.kind === "ticket")!;

    expect(said).toBe(`Added ${ticket.key} to To Do. The Architect Agent is drafting it.`);
    expect(ticket.key).toMatch(/^T-\d+$/);
    const onTicket = await repo.attachmentsFor({ ticketId: ticket.id });
    expect(onTicket).toHaveLength(1);
    expect((await repo.attachmentContent(onTicket[0]!.id))?.bytes).toEqual(new Uint8Array([7, 8]));
    expect((await repo.attachmentsFor({ assistantMessageId: note.id })).map((a) => a.id)).toEqual([shot.id]);
  });

  it("tells the PM a single playtest fix is a To Do ticket", () => {
    expect(PLAYTEST_RULE).toContain("create_todo_item");
    expect(PLAYTEST_RULE).toContain("create_todo_card");
  });

  it("tells the PM session to add one fix with create_todo_card and to name cards by their real keys", async () => {
    const prompt = await sessionSystemPrompt(PROJECT, null);
    expect(prompt).toContain("create_todo_card");
    expect(prompt).toMatch(/create_backlog_card is only for a new capability that needs a PRD/);
    expect(prompt).toContain("Name a card to the person only by the key and column a tool returned or list_cards shows");
  });

  async function plannedTickets() {
    const checked = checkAction({ type: "create_epic_with_tickets", title: "Export", summary: "CSV export", tickets: TICKETS });
    if (!checked.ok) throw new Error(checked.problem);
    const before = new Set((await repository().boardCards(PROJECT)).map((c) => c.id));
    await applyAction(PROJECT, checked.action);
    return (await repository().boardCards(PROJECT)).filter((c) => !before.has(c.id));
  }

  it("moves a card the way a drag would, and refuses what a drag would", async () => {
    const [epic, first] = (await plannedTickets()).sort((a, b) => a.key.localeCompare(b.key));

    expect(await applyAction(PROJECT, { type: "move_card", key: first!.key, to: "backlog" })).toContain("Backlog");
    expect((await repository().cardById(first!.id))?.status).toBe("draft");

    await expect(applyAction(PROJECT, { type: "move_card", key: epic!.key, to: "done" })).rejects.toThrow(/Epic is not worked on/);
    const after = (await repository().boardCards(PROJECT)).find((c) => c.id === epic!.id)!;
    expect([after.status, after.misplacedIn]).toEqual(["ready", null]);
    await expect(applyAction(PROJECT, { type: "move_card", key: "NOPE-1", to: "todo" })).rejects.toThrow(/not on the board/);
  });

  it("closes a ticket and an Epic by archiving them", async () => {
    const cards = await plannedTickets();
    const epic = cards.find((c) => c.kind === "epic")!;
    const ticket = cards.find((c) => c.kind === "ticket")!;

    expect(await applyAction(PROJECT, { type: "close_card", key: ticket.key, reason: "A duplicate." })).toContain("Archived");
    expect((await repository().boardCards(PROJECT)).some((c) => c.id === ticket.id)).toBe(false);

    expect(await applyAction(PROJECT, { type: "close_card", key: epic.key, reason: "Built already." })).toBe(
      `Archived ${epic.key} and its tickets.`,
    );
    expect((await repository().boardCards(PROJECT)).some((c) => c.id === epic.id)).toBe(false);
    expect(((await repository().archivedEpics(PROJECT)).cards).map((c) => c.id)).toEqual([epic.id]);
  });
});

describe("the assistant on a CLI plan", () => {
  async function cliArchitect() {
    const preset = await savePreset({ name: "arch", provider: "claude-code", model: "", prompt: "", apiKey: "sk-ant-oat01-plan" });
    await repository().setColumnAgent(PROJECT, "todo", preset.id);
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "install");
    return client;
  }

  it("answers as a CLI Architect in GitHub Actions when no API agent is set, and re-asks it, not the PM", async () => {
    const client = await cliArchitect();
    const [reply] = await askSpeakers("I want to plan an epic for online traffic", ["architect"]);

    await answer(PROJECT, reply!.id);

    const dispatch = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    expect(dispatch).toMatchObject({ mode: "ask", cli: "claude" });
    expect(dispatch.prompt).toContain("You are");
    expect(dispatch.prompt).toContain("online traffic");
    expect((await reload(reply!.id)).status).toBe("pending");

    const wrong = JSON.stringify({
      reply: "Here is the epic.",
      proposals: [
        { summary: "Add the export tickets", action: { type: "create_epic_with_tickets", title: "Export", summary: "s", tickets: TICKETS } },
        { summary: "Something broken", action: { type: "delete_everything" } },
      ],
    });
    await client.commitFile(`${STAGING_PREFIX}${dispatch.job}`, ANSWER_PATH, wrong, "answer");
    await completeCliRun(PROJECT, { job: dispatch.job!, mode: "ask", conclusion: "success", url: null });

    // The wrong proposal goes back to the Architect's agent with the Architect's prompt.
    const retry = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    expect(retry.job).not.toBe(dispatch.job);
    expect(retry.prompt).toContain("Formic could not use your proposals");
    expect(retry.prompt).toContain("You are");

    await client.commitFile(
      `${STAGING_PREFIX}${retry.job}`,
      ANSWER_PATH,
      JSON.stringify({
        reply: "Here is the epic.",
        proposals: [{ summary: "Add the export tickets", action: { type: "create_epic_with_tickets", title: "Export", summary: "s", tickets: TICKETS } }],
      }),
      "answer",
    );
    await completeCliRun(PROJECT, { job: retry.job!, mode: "ask", conclusion: "success", url: null });

    expect(await reload(reply!.id)).toMatchObject({ speaker: "architect", status: "done", content: "Here is the epic." });
    expect((await reload(reply!.id)).proposals.map((p) => p.summary)).toEqual(["Add the export tickets"]);
  });

  it("labels a notice in a CLI agent's prompt as the board's, not the person's or its own", async () => {
    await useAgent("claude-code");
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "install");
    await repository().addAssistantMessage({ projectId: PROJECT, role: "assistant", kind: "notice", content: "T-9 · Export is done." });
    const pending = await ask("What next?");

    await answer(PROJECT, pending.id);

    const prompt = MockVcsClient.runner().dispatches.at(-1)!.inputs.prompt!;
    expect(prompt).toContain("### Board (Formic, not the person and not you)\n[Board: T-9 · Export is done.]");
    expect(prompt).not.toContain("### You\nT-9 · Export is done.");
  });

  it("answers from GitHub Actions and keeps only valid proposals", async () => {
    await useAgent("claude-code");
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "install");
    const pending = await ask("Turn docs/tickets.md into tickets");

    await answer(PROJECT, pending.id);

    const dispatch = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    expect(dispatch).toMatchObject({ mode: "ask", cli: "claude" });
    expect(dispatch.prompt).toContain("Turn docs/tickets.md into tickets");
    expect((await reload(pending.id)).status).toBe("pending");

    await client.commitFile(
      `${STAGING_PREFIX}${dispatch.job}`,
      ANSWER_PATH,
      JSON.stringify({
        reply: "Here they are.",
        proposals: [
          {
            summary: "Add the export tickets",
            action: { type: "create_epic_with_tickets", title: "Export", summary: "s", tickets: TICKETS },
          },
          { summary: "Something broken", action: { type: "delete_everything" } },
        ],
      }),
      "answer",
    );
    await completeCliRun(PROJECT, { job: dispatch.job!, mode: "ask", conclusion: "success", url: null });

    // Sent back once, with what was wrong, instead of dropped on the spot.
    expect((await reload(pending.id)).status).toBe("pending");
    const retry = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    expect(retry.job).not.toBe(dispatch.job);
    expect(retry.prompt).toContain("Formic could not use your proposals");
    expect(retry.prompt).toContain("Something broken");

    // The second answer still has it wrong: now it is set aside.
    await client.commitFile(
      `${STAGING_PREFIX}${retry.job}`,
      ANSWER_PATH,
      JSON.stringify({
        reply: "Here they are.",
        proposals: [
          {
            summary: "Add the export tickets",
            action: { type: "create_epic_with_tickets", title: "Export", summary: "s", tickets: TICKETS },
          },
          { summary: "Something broken", action: { type: "delete_everything" } },
        ],
      }),
      "answer",
    );
    await completeCliRun(PROJECT, { job: retry.job!, mode: "ask", conclusion: "success", url: null });

    const done = await reload(pending.id);
    expect(done.status).toBe("done");
    expect(done.content).toContain("Here they are.");
    expect(done.content).toContain("could not use");
    expect(done.proposals.map((p) => p.summary)).toEqual(["Add the export tickets"]);
  });

  it("collects the answer from GitHub when the webhook never arrives", async () => {
    await useAgent("claude-code");
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "install");
    const pending = await ask("What tickets are there?");
    await answer(PROJECT, pending.id);
    const job = MockVcsClient.runner().dispatches.at(-1)!.inputs.job!;

    // Still running on GitHub: nothing changes.
    await collectCliRuns(PROJECT);
    expect((await reload(pending.id)).status).toBe("pending");

    // Finished, with its answer on the staging branch, and no webhook.
    await client.commitFile(`${STAGING_PREFIX}${job}`, ANSWER_PATH, '{"reply": "Three tickets."}', "a");
    MockVcsClient.runner().runs.set(runTitle("ask", "assistant", job), {
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/widgets/actions/runs/9",
    });
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ["Date"] });
    try {
      await collectCliRuns(PROJECT);
    } finally {
      vi.useRealTimers();
    }

    expect(await reload(pending.id)).toMatchObject({ status: "done", content: "Three tickets." });
  });

  it("shows a plain-text answer as the reply", async () => {
    const pending = await ask("Hi");
    await finishCliAnswer(pending.id, "Just text, no JSON.");
    const done = await reload(pending.id);
    expect(done.status).toBe("done");
    expect(done.content).toContain("Just text, no JSON.");
  });

  it("asks once more when the agent answers in prose, then says nothing can be approved", async () => {
    await useAgent("claude-code");
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "install");
    const pending = await ask("Yes please make the ticket");
    await answer(PROJECT, pending.id);
    const first = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    expect(first.prompt).toContain("do not ask again");
    expect(first.prompt).toContain("Your final message is your answer");

    await client.commitFile(`${STAGING_PREFIX}${first.job}`, ANSWER_PATH, "Should I propose it?", "answer");
    await completeCliRun(PROJECT, { job: first.job!, mode: "ask", conclusion: "success", url: null });

    expect((await reload(pending.id)).status).toBe("pending");
    const retry = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    expect(retry.job).not.toBe(first.job);
    expect(retry.prompt).toContain("not the JSON object");

    await client.commitFile(`${STAGING_PREFIX}${retry.job}`, ANSWER_PATH, "Still prose.", "answer");
    await completeCliRun(PROJECT, { job: retry.job!, mode: "ask", conclusion: "success", url: null });
    const done = await reload(pending.id);
    expect(done.status).toBe("done");
    expect(done.content).toContain("Still prose.");
    expect(done.content).toContain("nothing here can be approved");
    expect(done.proposals).toEqual([]);
  });

  it("keeps the proposal when the retry comes back as JSON", async () => {
    await useAgent("claude-code");
    const base = (await projectFor(PROJECT)).baseBranch;
    const client = new MockVcsClient("acme/widgets");
    await client.commitFile(base, RUNNER_WORKFLOW_PATH, runnerWorkflow(), "install");
    const pending = await ask("Yes please make the ticket");
    await answer(PROJECT, pending.id);
    const first = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    await client.commitFile(`${STAGING_PREFIX}${first.job}`, ANSWER_PATH, "Prose only.", "answer");
    await completeCliRun(PROJECT, { job: first.job!, mode: "ask", conclusion: "success", url: null });
    const retry = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    await client.commitFile(
      `${STAGING_PREFIX}${retry.job}`,
      ANSWER_PATH,
      JSON.stringify({
        reply: "Proposed.",
        proposals: [{ summary: "Add it", action: { type: "create_backlog_item", request: "Do it" } }],
      }),
      "answer",
    );
    await completeCliRun(PROJECT, { job: retry.job!, mode: "ask", conclusion: "success", url: null });
    const done = await reload(pending.id);
    expect(done.status).toBe("done");
    expect(done.proposals.map((p) => p.summary)).toEqual(["Add it"]);
  });
});

describe("pictures in the chat", () => {
  /** A user message carrying one image, as the route stores and claims it. */
  async function sendPicture(name: string, text: string) {
    const repo = repository();
    const row = await repo.createAttachment({
      projectId: PROJECT,
      requestId: `r-${name}`,
      filename: name,
      mimeType: "image/png",
      kind: "image",
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });
    const message = await repo.addAssistantMessage({ projectId: PROJECT, role: "user", content: text });
    await repo.claimAttachments(`r-${name}`, { assistantMessageId: message.id });
    return row;
  }

  it("sends the latest three messages' pictures as pixels and names older ones", async () => {
    for (const n of ["a.png", "b.png", "c.png", "d.png"]) await sendPicture(n, n === "d.png" ? "" : `see ${n}`);
    const past = await history((await repository().assistantMessages(PROJECT)).messages);
    expect(past.map((m) => m.images?.length ?? 0)).toEqual([0, 1, 1, 1]);
    expect(past[0]!.content).toBe("see a.png\n[Image: a.png]");
    expect(past[1]!.images![0]).toEqual({ mimeType: "image/png", base64: "AQID" });
    expect(past[3]!.content).toBe("");
  });

  it("hands an OpenAI-compatible model the image as a data URL on its own turn", async () => {
    await useAgent("groq");
    await sendPicture("shot.png", "what is this?");
    const sent = fakeProvider([{ role: "assistant", content: "A screenshot." }]);
    const pending = await repository().addAssistantMessage({ projectId: PROJECT, role: "assistant", content: "", status: "pending" });
    await answer(PROJECT, pending.id);
    const user = (sent[0]!.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === "user")!;
    expect(user.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      { type: "text", text: "what is this?" },
    ]);
  });
});

describe("re-running CI on a red ticket", () => {
  async function seedRed(blockedReason: string, status: "review" | "blocked" = "review") {
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "Coach", rawRequest: "r", position: 1 });
    const [ticket] = await repo.createTickets([
      { epicId: epic.id, key: "T-1", title: "Parallel tests", description: "d", acceptanceCriteria: ["c"], fileScope: ["src"], storyPoints: 3, position: 1, dependsOnKeys: [] },
    ]);
    const client = new MockVcsClient("acme/widgets");
    const pull = await client.openPullRequest({ headBranch: "formic/t-1", baseBranch: "main", title: "T-1", body: "" });
    MockVcsClient.setChecks(pull.number, "failure");
    (await client.checksFor(pull.headSha))[0]!.detailsUrl = "https://github.com/acme/widgets/actions/runs/55/job/1";
    MockVcsClient.runner().branchRuns.set(pull.headBranch, [
      { name: "CI", sha: pull.headSha, status: "completed", conclusion: "failure", attempt: 1, startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", url: "https://github.com/acme/widgets/actions/runs/55" },
    ]);
    await repo.updateTicket(ticket!.id, {
      status,
      stalledIn: status === "blocked" ? "in_review" : null,
      stage: 6,
      prNumber: pull.number,
      branchName: "formic/t-1",
      blockedReason,
    });
    return { ticket: ticket!, client };
  }

  it("does not re-run a failure the code caused, and brings main in instead", async () => {
    const { ticket, client } = await seedRed("Waiting on #726, then updates from main", "blocked");
    await client.commitFile("formic/t-1", "src/lib/example.ts", "x", "c");

    const said = await applyAction(PROJECT, { type: "rerun_ci", key: ticket.key });

    expect(said).toMatch(/T-1/);
    expect(MockVcsClient.runner().reruns).toEqual([]);
    const { messages } = await repository().assistantMessages(PROJECT);
    expect(messages.flatMap((m) => m.proposals)).toEqual([]);
  });

  it("does not re-run when the failing check's annotation names a file in the repository", async () => {
    const { ticket, client } = await seedRed("CI is red on build.");
    await client.commitFile("formic/t-1", "src/lib/example.ts", "x", "c");

    await applyAction(PROJECT, { type: "rerun_ci", key: ticket.key });
    expect(MockVcsClient.runner().reruns).toEqual([]);
  });

  it("re-runs a failure with no code annotation, as before", async () => {
    const { ticket } = await seedRed("CI is red on build.");

    expect(await applyAction(PROJECT, { type: "rerun_ci", key: ticket.key })).toContain("Re-running");
    expect(MockVcsClient.runner().reruns).toEqual([55]);
  });

  it("rewrites the reason of the card an opened pull request unblocks, keeping the reason's detail", async () => {
    const { ticket, client } = await seedRed("CI is red on build.\nFailing assertion: x", "blocked");
    const branch = `${ASSISTANT_BRANCH_PREFIX}fix`;
    await client.commitFile(branch, "src/lib/fix.ts", "x", "c");

    const said = await applyAction(PROJECT, { type: "open_pull_request", branch, title: "Fix", body: "b", unblocks: ticket.key });

    const number = Number(/#(\d+)/.exec(said)![1]);
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason!.split("\n")).toEqual([`Waiting on #${number}, then updates from main`, "CI is red on build.", "Failing assertion: x"]);
  });

  it("accepts update_branch and describes it to the PM", () => {
    expect(checkAction({ type: "update_branch", key: "T-1" }).ok).toBe(true);
  });
});
