import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answer, changeBranchFor } from "./turn";
import { applyAction, checkAction } from "./actions";
import { boardSnapshot, mentionedKeys } from "./context";
import { savePreset } from "@/lib/agents/presets";
import { resetAgents } from "@/lib/agents/registry";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { BoardCard } from "@/lib/domain/entities";
import { completeCliRun } from "@/lib/runner/runner";
import { ANSWER_PATH, RUNNER_WORKFLOW_PATH, runTitle } from "@/lib/runner/workflow";
import { currentRunnerFiles } from "@/lib/runner/bundle";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, STAGING_PREFIX, resetVcs, setVcs } from "@/lib/vcs";

/**
 * What the board's assistant can do beyond answering: see a card's live
 * state, make a change itself, re-run a check that failed on its own, and
 * put new work in the Epic it belongs to.
 */

const PROJECT = "project_default";
const REPO = "acme/widgets";

const spec = (key: string, scope: string, dependsOn: string[] = []) => ({
  key,
  title: `Ticket ${key}`,
  userStory: { as: "a board owner", want: "it to work", soThat: "my work moves on" },
  requirements: [],
  acceptanceCriteria: [{ given: "the board", when: "it runs", then: "it works" }],
  fileScope: [scope],
  storyPoints: 3,
  type: "task",
  dependsOn,
});

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

/** An Epic with one ticket in review on a red pull request. */
async function seedRedTicket() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Plans", rawRequest: "r", position: 1 });
  const [ticket] = await repo.createTickets([
    {
      epicId: epic.id,
      key: "T-94",
      title: "Plan atop the ticket view",
      description: "d",
      acceptanceCriteria: ["c"],
      fileScope: ["src/components"],
      storyPoints: 3,
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  const client = new MockVcsClient(REPO);
  const pull = await client.openPullRequest({ headBranch: "formic/t-94", baseBranch: "main", title: "T-94", body: "" });
  MockVcsClient.setChecks(pull.number, "failure");
  (await client.checksFor(pull.headSha))[0]!.detailsUrl = `https://github.com/${REPO}/actions/runs/55/job/1`;
  MockVcsClient.runner().branchRuns.set(pull.headBranch, [
    {
      name: "CI",
      sha: pull.headSha,
      status: "completed",
      conclusion: "failure",
      attempt: 1,
      startedAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      url: `https://github.com/${REPO}/actions/runs/55`,
    },
  ]);
  await repo.updateTicket(ticket!.id, {
    status: "review",
    stage: 6,
    prNumber: pull.number,
    branchName: "formic/t-94",
    blockedReason: "CI is red on build.",
  });
  return { epic, ticket: ticket!, pull, client };
}

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetAgents();
  resetVcs();
  setVcs(new MockVcsClient(REPO));
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

describe("what the assistant knows of the board", () => {
  it("finds a card however the person writes its key", () => {
    const cards = [{ key: "T-94" }, { key: "T-9" }, { key: "EPIC-12" }, { key: "EPIC-12-T3" }];
    expect(mentionedKeys("whats wrong with t94?", cards)).toEqual(["T-94"]);
    expect(mentionedKeys("what's taking so long on t 94", cards)).toEqual(["T-94"]);
    expect(mentionedKeys("compare T-9 and epic-12-t3", cards).sort()).toEqual(["EPIC-12-T3", "T-9"]);
    expect(mentionedKeys("nothing here, not even t940", cards)).toEqual([]);
  });

  it("keeps every open card and why it is there, however much is finished", () => {
    const card = (over: Partial<BoardCard>): BoardCard => ({
      id: over.key!,
      kind: "ticket",
      key: "",
      title: "A title that takes some room on the line",
      status: "merged",
      stalledIn: null,
      stage: 7,
      position: 0,
      epicId: "E",
      size: null,
      agentRole: null,
      model: null,
      fileScope: ["src/lib/somewhere"],
      dependsOn: [],
      prNumber: null,
      prUrl: null,
      blockedReason: null,
      costCents: 0,
      childCount: 0,
      doneCount: 0,
      ...over,
    });
    const done = Array.from({ length: 400 }, (_, i) => card({ key: `EPIC-${i}`, kind: "epic", status: "merged" }));
    const merged = Array.from({ length: 300 }, (_, i) => card({ key: `T-${i}` }));
    const open = card({ key: "T-994", status: "review", prNumber: 795, blockedReason: "CI is red on build." });
    const snapshot = boardSnapshot([card({ id: "E", key: "EPIC-E", kind: "epic", status: "running" }), ...done, ...merged, open]);
    expect(snapshot).toContain("T-994 [In Review · review]");
    expect(snapshot).toContain("reason: CI is red on build.");
    expect(snapshot).not.toContain("- T-1 [");
  });

  it("reads a card's live state on GitHub, red check and all", async () => {
    await useAgent("groq");
    await seedRedTicket();
    const sent = fakeProvider([
      { role: "assistant", content: null, tool_calls: [call("c1", "card_status", { key: "t-94" })] },
      { role: "assistant", content: "Its build check is red." },
    ]);
    const pending = await ask("whats wrong with t94?");

    await answer(PROJECT, pending.id);

    const tool = (sent[1]!.messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!;
    expect(tool.content).toContain("Reason shown on the card: CI is red on build.");
    expect(tool.content).toContain("check ci / test: failure");
    expect(tool.content).toContain("Why ci / test failed:");
  });

  it("hands a CLI agent the live state of the cards it is asked about", async () => {
    await useAgent("claude-code");
    const base = (await projectFor(PROJECT)).baseBranch;
    await new MockVcsClient(REPO).commitFile(base, RUNNER_WORKFLOW_PATH, (await currentRunnerFiles()).workflow, "install");
    const { ticket } = await seedRedTicket();
    MockVcsClient.runner().runs.set(runTitle("fix", "T-94", `${ticket.id}--abc`), {
      status: "completed",
      conclusion: "success",
      url: `https://github.com/${REPO}/actions/runs/9`,
    });
    const pending = await ask("is t 94 stuck?");

    await answer(PROJECT, pending.id);

    const prompt = MockVcsClient.runner().dispatches.at(-1)!.inputs.prompt!;
    expect(prompt).toContain("The live state of the cards the person asked about");
    expect(prompt).toContain("Reason shown on the card: CI is red on build.");
    expect(prompt).toContain(`- fix: success https://github.com/${REPO}/actions/runs/9`);
  });
});

describe("changing the code without a ticket", () => {
  it("commits to a branch of its own and proposes the pull request", async () => {
    await useAgent("groq");
    const pending = await ask("Fix the typo in the README");
    const branch = changeBranchFor(pending.id);
    fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c1", "write_file", { path: "README.md", content: "Fixed.", message: "Fix the typo" })],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("c2", "propose", {
            summary: "Open a pull request: Fix the README typo",
            action: { type: "open_pull_request", branch, title: "Fix the README typo", body: "One word." },
          }),
        ],
      },
      { role: "assistant", content: "Proposed the fix as a pull request." },
    ]);

    await answer(PROJECT, pending.id);

    const client = new MockVcsClient(REPO);
    expect(await client.readFile("README.md", branch)).toBe("Fixed.");
    expect(await client.readFile("README.md", (await projectFor(PROJECT)).baseBranch)).toBeNull();
    const done = (await repository().assistantMessage(pending.id))!;
    expect(done.proposals).toHaveLength(1);

    const checked = checkAction(done.proposals[0]!.action);
    if (!checked.ok) throw new Error(checked.problem);
    const said = await applyAction(PROJECT, checked.action);
    expect(said).toMatch(/^Opened pull request #\d+/);
    expect((await client.findPullRequest(branch))?.baseBranch).toBe((await projectFor(PROJECT)).baseBranch);
  });

  it("refuses a workflow file, and a branch that is not its own", async () => {
    expect(checkAction({ type: "open_pull_request", branch: "main", title: "t", body: "b" }).ok).toBe(false);

    await useAgent("groq");
    const sent = fakeProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [call("c1", "write_file", { path: ".github/workflows/ci.yml", content: "x" })],
      },
      { role: "assistant", content: "I cannot change that one." },
    ]);
    const pending = await ask("Change CI");
    await answer(PROJECT, pending.id);
    const tool = (sent[1]!.messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!;
    expect(tool.content).toContain("Workflow files cannot be changed");
  });

  it("offers a CLI agent's change as a pull request", async () => {
    await useAgent("claude-code");
    const client = new MockVcsClient(REPO);
    const base = (await projectFor(PROJECT)).baseBranch;
    await client.commitFile(base, RUNNER_WORKFLOW_PATH, (await currentRunnerFiles()).workflow, "install");
    const pending = await ask("Fix mergePlan's ordering");
    await answer(PROJECT, pending.id);
    const job = MockVcsClient.runner().dispatches.at(-1)!.inputs.job!;

    await client.commitFile(`${STAGING_PREFIX}${job}-change`, "src/lib/agents/plan.ts", "fixed", "change");
    const changeSha = await client.branchHead(`${STAGING_PREFIX}${job}-change`);
    await client.commitFile(
      `${STAGING_PREFIX}${job}`,
      ANSWER_PATH,
      JSON.stringify({ reply: "Fixed it.", proposals: [], change: { title: "Keep reviewer steps last", body: "Tests pass." } }),
      "answer",
    );
    await completeCliRun(PROJECT, { job, mode: "ask", conclusion: "success", url: null });

    const done = (await repository().assistantMessage(pending.id))!;
    expect(done.status).toBe("done");
    const action = done.proposals[0]!.action as { type: string; branch: string; title: string };
    expect(action).toMatchObject({ type: "open_pull_request", title: "Keep reviewer steps last" });
    expect(await client.branchHead(action.branch)).toBe(changeSha);
    expect(await client.branchHead(`${STAGING_PREFIX}${job}-change`)).toBeNull();
  });
});

describe("acting on the board for the person", () => {
  it("re-runs a ticket's red check once", async () => {
    const { ticket } = await seedRedTicket();

    expect(await applyAction(PROJECT, { type: "rerun_ci", key: ticket.key })).toContain("Re-running");
    expect(MockVcsClient.runner().reruns).toEqual([55]);
    // Its second attempt is on the books: a third is not the assistant's to start.
    await expect(applyAction(PROJECT, { type: "rerun_ci", key: ticket.key })).rejects.toThrow(/already re-ran/);
  });

  it("adds a follow-up to the Epic it belongs to, after the ticket it follows", async () => {
    const { epic, ticket } = await seedRedTicket();
    const checked = checkAction({
      type: "add_tickets_to_epic",
      epic: epic.key,
      tickets: [spec("F-1", "src/lib/agents", [ticket.key])],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;

    const said = await applyAction(PROJECT, checked.action);

    const cards = await repository().boardCards(PROJECT);
    const added = cards.find((c) => c.key === `${epic.key}-T2`)!;
    expect(said).toBe(`Added ${epic.key}-T2 to ${epic.key}.`);
    expect(added.epicId).toBe(epic.id);
    expect(added.status).toBe("waiting");
    expect(added.dependsOn).toEqual([ticket.id]);
    expect(cards.some((c) => c.id === ticket.id)).toBe(true);
  });

  it("refuses a follow-up that would clash with an open ticket's files", async () => {
    const { epic } = await seedRedTicket();
    await expect(
      applyAction(PROJECT, { type: "add_tickets_to_epic", epic: epic.key, tickets: [spec("F-1", "src/components") as never] }),
    ).rejects.toThrow(/clash/);
  });
});
