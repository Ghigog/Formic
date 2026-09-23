import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answer, finishCliAnswer } from "./turn";
import { applyAction, checkAction } from "./actions";
import { savePreset } from "@/lib/agents/presets";
import { resetAgents } from "@/lib/agents/registry";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { collectCliAsk, completeCliRun } from "@/lib/runner/runner";
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
    context: "Why it is needed.",
    description: "Serve the CSV.",
    requirements: ["Covered by a test"],
    acceptanceCriteria: [{ given: "the board", when: "it runs", then: "It downloads" }],
    fileScope: ["src/app/api/export"],
    size: "S",
    dependsOn: [],
  },
  {
    key: "T-2",
    title: "Export button",
    userStory: { as: "a board owner", want: "A button that calls it", soThat: "my work moves on" },
    context: "Why it is needed.",
    description: "A button that calls it.",
    requirements: ["Covered by a test"],
    acceptanceCriteria: [{ given: "the board", when: "it runs", then: "It is on the board" }],
    fileScope: ["src/components/export"],
    size: "S",
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
    expect(tickets.map((t) => t.key).sort()).toEqual(["T-1", "T-2"]);
    expect(said).toContain("2 tickets");
  });
});

describe("the assistant on a CLI plan", () => {
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
    await collectCliAsk(PROJECT, pending.id);
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
      await collectCliAsk(PROJECT, pending.id);
    } finally {
      vi.useRealTimers();
    }

    expect(await reload(pending.id)).toMatchObject({ status: "done", content: "Three tickets." });
  });

  it("shows a plain-text answer as the reply", async () => {
    const pending = await ask("Hi");
    await finishCliAnswer(pending.id, "Just text, no JSON.");
    expect(await reload(pending.id)).toMatchObject({ status: "done", content: "Just text, no JSON." });
  });
});
