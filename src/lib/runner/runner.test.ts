import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STOPPED_BY_PERSON,
  attachmentUrlAllowed,
  cliPrompt,
  mergedFrom,
  PLAN_FIRST_RULE,
  collectCliRuns,
  completeCliRun,
  jobTimeoutMinutes,
  receiveReport,
  reportAllowed,
  reviewVerdictOf,
  secretNameFor,
  signedAttachmentUrl,
  startJobRun,
  stopTicket,
  usageOf,
} from "./runner";
import { addNote } from "@/lib/coder/notes";
import {
  ALREADY_DONE_TRAILER,
  ANSWER_PATH,
  CARRY_DELETED,
  CHECKPOINT_TRAILER,
  RUNNER_ENTRY_PATH,
  RUNNER_WORKFLOW_NAME,
  RUNNER_WORKFLOW_PATH,
  USAGE_TRAILER,
  parseRunTitle,
  runTitle,
  runnerWorkflow,
} from "./workflow";
import { currentRunnerFiles, setLoopBundleDir } from "./bundle";
import { runCoderAgent } from "@/lib/coder/pipeline";
import { reviewPullRequest } from "@/lib/review/pipeline";
import { cliAgentFor, loopAgentFor, savePreset } from "@/lib/agents/presets";
import { runArchitectAgent, runArchitectDraftTicket, runProductAgent, startRun } from "@/lib/agents/pipeline";
import type { ColumnId } from "@/lib/domain/status";
import { provider } from "@/lib/llm/providers";
import { resetAgents } from "@/lib/agents/registry";
import { projectFor } from "@/lib/board/project";
import { redraftTicket } from "@/lib/board/service";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { resetMergeLanes } from "@/lib/review/lane";
import { interpret } from "@/lib/review/webhook";
import { resetEnvCache } from "@/lib/secrets/env";
import { updateRunTimeBudgetSettings } from "@/lib/user-settings";
import type { RunTimeBudgetSettings } from "@/lib/run-time-budget";
import { MockVcsClient, STAGING_PREFIX, resetVcs, setVcs } from "@/lib/vcs";

/**
 * The cloud runner on a mock GitHub: setting a repository up, starting a CLI
 * agent in Actions, and taking its work back through the same gates as any
 * other agent's.
 */

const PROJECT = "project_default";
const TOKEN = "sk-ant-oat01-plan-token-9876";

async function seedTicket(fileScope = ["src/lib/feature"]): Promise<TicketDetail> {
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
      description: "The thing, done.",
      acceptanceCriteria: ["It is done"],
      fileScope,
      size: "M",
      storyPoints: 3,
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  return (await repo.ticketDetail(ticket!.id))!;
}

async function assignClaudeCode(column: ColumnId = "in_progress") {
  const preset = await savePreset({
    name: "my-claude",
    provider: "claude-code",
    model: "",
    prompt: "Implement the ticket.",
    apiKey: TOKEN,
  });
  await repository().setColumnAgent(PROJECT, column, preset.id);
  return preset;
}

async function installRunner(): Promise<string> {
  const base = (await projectFor(PROJECT)).baseBranch;
  const { workflow } = await currentRunnerFiles();
  await new MockVcsClient("acme/widgets").commitFile(base, RUNNER_WORKFLOW_PATH, workflow, "install");
  return base;
}

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetMergeLanes();
  resetAgents();
  resetVcs();
  setVcs(new MockVcsClient("acme/widgets"));
  vi.stubEnv("AGENT_PROVIDER", "mock");
  vi.stubEnv("FORMIC_SECRET", "test");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
  setLoopBundleDir(null);
});

describe("CLI agent templates", () => {
  it("run in any column", async () => {
    const preset = await assignClaudeCode();
    for (const column of ["backlog", "todo", "in_review", "done"] as const) {
      await repository().setColumnAgent(PROJECT, column, preset.id);
    }

    for (const column of ["backlog", "todo", "in_progress", "in_review", "done"] as const) {
      expect(await cliAgentFor(PROJECT, column)).toMatchObject({
        credential: TOKEN,
        model: null,
        info: { cli: "claude", secretName: "FORMIC_CLAUDE_CODE_TOKEN" },
      });
    }
  });
});

describe("a CLI agent planning an Epic", () => {
  const PRD = {
    summary: "Let people export their board",
    problem: "Boards cannot leave Formic.",
    scope: ["A CSV export"],
    outOfScope: [],
    technicalContext: [],
    userStories: [],
    successCriteria: ["The export opens in a spreadsheet"],
  };
  const TICKETS = {
    tickets: [
      {
        key: "T-1",
        title: "Export endpoint",
        userStory: { as: "a board owner", want: "Serve the CSV", soThat: "my work moves on" },
        requirements: ["Covered by a test"],
        acceptanceCriteria: [{ given: "the board", when: "it runs", then: "It downloads" }],
        fileScope: ["src/app/api/export"],
        size: "S",
        storyPoints: 3,
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
        dependsOn: ["T-1"],
      },
    ],
  };

  async function seedEpic(prd: unknown = null) {
    const repo = repository();
    const epic = await repo.createEpic({
      projectId: PROJECT,
      title: "Export",
      rawRequest: "Let me export my board as CSV",
      position: 1,
    });
    if (prd) await repo.setEpicPrd(epic.id, prd, false);
    return epic;
  }

  function answer(job: string, text: string) {
    return new MockVcsClient("acme/widgets").commitFile(
      `${STAGING_PREFIX}${job}`,
      ANSWER_PATH,
      text,
      "answer",
    );
  }

  function lastDispatch() {
    return MockVcsClient.runner().dispatches.at(-1)!.inputs;
  }

  it("drafts the PRD in Actions and puts it on the Epic", async () => {
    await assignClaudeCode("backlog");
    const base = await installRunner();
    const epic = await seedEpic();

    await runProductAgent(PROJECT, epic.id, "Let me export my board as CSV");

    const inputs = lastDispatch();
    expect(inputs).toMatchObject({ mode: "product", cli: "claude", from: base });
    expect(inputs.prompt).toContain("Let me export my board as CSV");
    expect(inputs.prompt).toContain("FORMIC_OUTPUT");
    expect((await repository().epicDetail(epic.id))!.runnerJob).toBe(inputs.job);

    // Agents often wrap their JSON in a fence; that is fine.
    await answer(inputs.job!, "```json\n" + JSON.stringify({ title: "Export", prd: PRD }) + "\n```");
    await completeCliRun(PROJECT, { job: inputs.job!, mode: "product", conclusion: "success", url: null });

    const after = (await repository().epicDetail(epic.id))!;
    expect(after.prd).toMatchObject(PRD);
    expect(after.runnerJob).toBeNull();
    expect((await repository().cardById(epic.id))!.status).toBe("specified");
    expect(MockVcsClient.runner().branches.has(`${STAGING_PREFIX}${inputs.job}`)).toBe(false);
  });

  it("gives a CLI agent a signed URL for each attachment, with its filename and kind", async () => {
    vi.stubEnv("FORMIC_URL", "https://formic.example");
    await assignClaudeCode("backlog");
    await installRunner();
    const epic = await seedEpic();
    const attachment = await repository().createAttachment({
      projectId: PROJECT,
      epicId: epic.id,
      filename: "mockup.png",
      mimeType: "image/png",
      kind: "image",
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });

    await runProductAgent(PROJECT, epic.id, "Let me export my board as CSV");

    const { prompt } = lastDispatch();
    expect(prompt).toContain("mockup.png (image):");
    expect(prompt).toContain(`https://formic.example/api/attachments/${attachment.id}?`);
    expect(prompt).toContain("FORMIC_ATTACHMENTS");
  });

  it("keeps a stalled Epic stalled, with why, across a reload", async () => {
    await assignClaudeCode("backlog");
    await installRunner();
    const epic = await seedEpic(null);

    await runProductAgent(PROJECT, epic.id, "Let me export my board as CSV");
    const { job } = lastDispatch();
    await completeCliRun(PROJECT, { job: job!, mode: "product", conclusion: "cancelled", url: null });

    // What a refresh reads: the stored card, not the event.
    const card = (await repository().boardCards(PROJECT)).find((c) => c.id === epic.id)!;
    expect(card).toMatchObject({ status: "failed", stalledIn: "backlog", stage: 2 });
    expect(card.blockedReason).toContain("cancelled");

    // Moving it on clears the reason.
    await repository().move({ cardId: epic.id, kind: "epic", status: "draft", stalledIn: null, position: 1 });
    expect((await repository().cardById(epic.id))!.blockedReason).toBeNull();
  });

  it("sends an unsafe ticket graph back as a correction, then takes the fixed one", async () => {
    await assignClaudeCode("todo");
    await installRunner();
    const epic = await seedEpic(PRD);

    await runArchitectAgent(PROJECT, epic.id, "Export", PRD, ["src"]);
    const first = lastDispatch();
    expect(first.mode).toBe("architect");
    expect(first.prompt).toContain("A CSV export");

    // Two tickets that could run together, on the same directory.
    const clash = structuredClone(TICKETS);
    clash.tickets[1]!.fileScope = ["src/app/api/export"];
    clash.tickets[1]!.dependsOn = [];
    await answer(first.job!, JSON.stringify(clash));
    await completeCliRun(PROJECT, { job: first.job!, mode: "architect", conclusion: "success", url: null });

    const second = lastDispatch();
    expect(second.job).not.toBe(first.job);
    expect(second.prompt).toContain("attempt 2 of 3");
    expect(second.prompt).toContain("not safe to run");
    expect(await repository().ticketsForEpic(epic.id)).toHaveLength(0);

    await answer(second.job!, JSON.stringify(TICKETS));
    await completeCliRun(PROJECT, { job: second.job!, mode: "architect", conclusion: "success", url: null });

    const tickets = await repository().ticketsForEpic(epic.id);
    expect(tickets.map((t) => t.key).sort()).toEqual(["T-1", "T-2"]);
    expect((await repository().epicDetail(epic.id))!.runnerJob).toBeNull();
  });

  it("gives a To Do CLI agent the same signed attachment URLs", async () => {
    vi.stubEnv("FORMIC_URL", "https://formic.example");
    await assignClaudeCode("todo");
    await installRunner();
    const epic = await seedEpic(PRD);
    const attachment = await repository().createAttachment({
      projectId: PROJECT,
      epicId: epic.id,
      filename: "notes.txt",
      mimeType: "text/plain",
      kind: "file",
      size: 5,
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
    });

    await runArchitectAgent(PROJECT, epic.id, "Export", PRD, ["src"]);

    const { prompt } = lastDispatch();
    expect(prompt).toContain("notes.txt (file):");
    expect(prompt).toContain(`https://formic.example/api/attachments/${attachment.id}?`);
  });

  it("gives up after the last attempt instead of asking forever", async () => {
    await assignClaudeCode("todo");
    await installRunner();
    const epic = await seedEpic(PRD);

    await runArchitectAgent(PROJECT, epic.id, "Export", PRD, ["src"]);
    for (let i = 0; i < 3; i++) {
      const job = lastDispatch().job!;
      await answer(job, "I could not decide.");
      await completeCliRun(PROJECT, { job, mode: "architect", conclusion: "success", url: null });
    }

    expect(MockVcsClient.runner().dispatches).toHaveLength(3);
    expect(await repository().ticketsForEpic(epic.id)).toHaveLength(0);
    expect((await repository().epicDetail(epic.id))!.runnerJob).toBeNull();
  });

  it("ignores an answer nobody is waiting for", async () => {
    await assignClaudeCode("backlog");
    await installRunner();
    const epic = await seedEpic();
    await runProductAgent(PROJECT, epic.id, "x");

    const stale = `${epic.id}--oldjob00`;
    await answer(stale, JSON.stringify({ title: "Old", prd: PRD }));
    await completeCliRun(PROJECT, { job: stale, mode: "product", conclusion: "success", url: null });

    const after = (await repository().epicDetail(epic.id))!;
    expect(after.prd).toBeNull();
    expect(after.runnerJob).toBe(lastDispatch().job);
  });

  const REROUTE_TICKET = {
    key: "T-1",
    title: "Export button",
    userStory: { as: "a board owner", want: "export my board as CSV", soThat: "I can report on it elsewhere" },
    context: "Boards cannot leave Formic.",
    description: "Add a button that downloads the board as CSV.",
    requirements: ["Covered by a test"],
    acceptanceCriteria: [{ given: "the board", when: "I click export", then: "a CSV downloads" }],
    fileScope: ["src/components/export"],
    size: "S",
    storyPoints: 3,
    dependsOn: [],
  };

  it("answers reroute in Actions and moves the request into To Do as that ticket", async () => {
    await assignClaudeCode("backlog");
    await installRunner();
    const epic = await seedEpic();

    await runProductAgent(PROJECT, epic.id, "Let me export my board as CSV");
    const { job } = lastDispatch();

    await answer(
      job!,
      JSON.stringify({ kind: "reroute", reason: "Small enough for one ticket.", ticket: REROUTE_TICKET }),
    );
    await completeCliRun(PROJECT, { job: job!, mode: "product", conclusion: "success", url: null });

    const cards = await repository().boardCards(PROJECT);
    expect(cards.some((c) => c.id === epic.id)).toBe(false);
    const drafted = cards.find((c) => c.epicId === epic.id && c.kind === "ticket")!;
    expect(drafted).toMatchObject({
      title: REROUTE_TICKET.title,
      fileScope: REROUTE_TICKET.fileScope,
      status: "ready",
      rerouteFrom: "backlog",
      rerouteReason: "Small enough for one ticket.",
    });
    expect(drafted.blockedReason).toBeNull();
  });

  it("sends an answer matching neither shape back as a correction, without moving the card", async () => {
    await assignClaudeCode("backlog");
    await installRunner();
    const epic = await seedEpic();

    await runProductAgent(PROJECT, epic.id, "Let me export my board as CSV");
    const first = lastDispatch();

    await answer(first.job!, JSON.stringify({ nonsense: true }));
    await completeCliRun(PROJECT, { job: first.job!, mode: "product", conclusion: "success", url: null });

    const second = lastDispatch();
    expect(second.job).not.toBe(first.job);
    expect(second.prompt).toContain("attempt 2 of 2");

    const card = (await repository().boardCards(PROJECT)).find((c) => c.id === epic.id)!;
    expect(card.status).not.toBe("blocked");
    expect(card.status).not.toBe("failed");
    expect((await repository().epicDetail(epic.id))!.runnerJob).toBe(second.job);
  });
});

describe("a CLI agent drafting a To Do request's single ticket", () => {
  const REQUEST = "Each column's agent picker should only show its own agents";
  const SPEC = {
    key: "T-1",
    title: "Keep reviewer agents out of To Do",
    userStory: { as: "a board owner", want: "see only To Do agents there", soThat: "picking one is quick" },
    context: "Every agent shows in every column.",
    description: "Scope each agent to the column it was made for.",
    requirements: ["Covered by a test"],
    acceptanceCriteria: [{ given: "a reviewer agent", when: "I open To Do's picker", then: "it is not there" }],
    fileScope: ["src/components/agents"],
    size: "S",
    storyPoints: 3,
    dependsOn: [],
  };

  async function seedDrafting() {
    const repo = repository();
    const epic = await repo.createEpic({
      projectId: PROJECT,
      title: "Scope agents",
      rawRequest: REQUEST,
      position: 0,
    });
    await repo.setStandalone(epic.id, true);
    const [ticket] = await repo.createTickets([
      {
        epicId: epic.id,
        key: "T-1",
        title: "Scope agents",
        description: REQUEST,
        acceptanceCriteria: [],
        fileScope: [],
        size: "M",
        storyPoints: null,
        position: 1,
        dependsOnKeys: [],
      },
    ]);
    await repo.move({ cardId: ticket!.id, kind: "ticket", status: "blocked", stalledIn: "todo", position: 1, detached: true });
    return { epic, ticket: ticket! };
  }

  function answer(job: string, text: string) {
    return new MockVcsClient("acme/widgets").commitFile(`${STAGING_PREFIX}${job}`, ANSWER_PATH, text, "answer");
  }

  function lastDispatch() {
    return MockVcsClient.runner().dispatches.at(-1)!.inputs;
  }

  it("drafts it in Actions and replaces the placeholder with it", async () => {
    await assignClaudeCode("todo");
    await installRunner();
    const { epic, ticket } = await seedDrafting();

    await runArchitectDraftTicket(PROJECT, epic.id, ticket.id, REQUEST, ["src"]);

    const inputs = lastDispatch();
    expect(inputs.mode).toBe("architect");
    expect(inputs.prompt).toContain("Each column's agent picker should only show its own agents");
    expect(inputs.prompt).toContain("FORMIC_OUTPUT");
    expect((await repository().ticketDetail(ticket.id))!.runnerJob).toBe(inputs.job);

    await answer(inputs.job!, JSON.stringify(SPEC));
    await completeCliRun(PROJECT, { job: inputs.job!, mode: "architect", conclusion: "success", url: null });

    const [drafted] = await repository().ticketsForEpic(epic.id);
    expect(drafted).toMatchObject({ title: SPEC.title, fileScope: SPEC.fileScope, status: "ready" });
    expect(MockVcsClient.runner().branches.has(`${STAGING_PREFIX}${inputs.job}`)).toBe(false);
  });

  it("sends a malformed ticket back once, then stalls it in To Do", async () => {
    await assignClaudeCode("todo");
    await installRunner();
    const { epic, ticket } = await seedDrafting();

    await runArchitectDraftTicket(PROJECT, epic.id, ticket.id, REQUEST, []);
    const first = lastDispatch();
    await answer(first.job!, JSON.stringify({ title: "no" }));
    await completeCliRun(PROJECT, { job: first.job!, mode: "architect", conclusion: "success", url: null });

    const second = lastDispatch();
    expect(second.job).not.toBe(first.job);
    expect(second.prompt).toContain("attempt 2 of 2");
    await answer(second.job!, JSON.stringify({ title: "still no" }));
    await completeCliRun(PROJECT, { job: second.job!, mode: "architect", conclusion: "success", url: null });

    const card = (await repository().cardById(ticket.id))!;
    expect(card).toMatchObject({ status: "failed", stalledIn: "todo" });
    expect(card.blockedReason).toContain("could not be used");
    expect(MockVcsClient.runner().dispatches).toHaveLength(2);

    // Asking again drafts it afresh.
    expect(await redraftTicket(PROJECT, ticket.id)).toBe(true);
    await vi.waitFor(() => expect(MockVcsClient.runner().dispatches).toHaveLength(3));
    expect((await repository().cardById(ticket.id))!.blockedReason).toBe("Drafting the ticket…");
  });
});

describe("starting a CLI agent", () => {
  it("opens a setup pull request first, and waits for a person to merge it", async () => {
    // The loop entry is committed with the workflow; the fixture stands in for
    // a built entry, which is a gitignored build artifact absent from `npm test`.
    setLoopBundleDir("src/test/loop-entry-bundle");
    await assignClaudeCode();
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    // The pull request is in the reason, so the card can hand a person the
    // address to merge rather than telling them to move the card and retry.
    expect(after.blockedReason).toMatch(
      /GitHub Actions\. Merge the setup pull request once \(https:\/\/\S+\), then try again\.$/,
    );
    const runner = MockVcsClient.runner();
    const { branch, version } = await currentRunnerFiles();
    expect(runner.files.get(`${branch}:${RUNNER_WORKFLOW_PATH}`)).toContain(RUNNER_WORKFLOW_NAME);
    // The pair: the loop entry is committed with the workflow, on its branch,
    // so a job runs it from its own checkout and fetches nothing.
    expect(runner.files.get(`${branch}:${RUNNER_ENTRY_PATH}`)).toContain("formic loop entry");
    // A branch per version, so each setup starts from the base as it is now.
    expect(branch).toBe(`formic/setup-runner-${version.split(": ")[1]}`);
    expect(runner.dispatches).toHaveLength(0);
    expect(runner.secrets.size).toBe(0);
  });

  it("stores the plan token as the agent's own secret and dispatches the workflow", async () => {
    const preset = await assignClaudeCode();
    const base = await installRunner();
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const runner = MockVcsClient.runner();
    const secret = secretNameFor({ presetId: preset.id, info: { secretName: "FORMIC_CLAUDE_CODE_TOKEN" } as never });
    expect(secret).toMatch(/^FORMIC_CLAUDE_CODE_TOKEN_[A-Z0-9_]+$/);
    expect(runner.secrets.get(secret)).toBe(TOKEN);
    expect(runner.dispatches).toHaveLength(1);
    const { file, ref, inputs } = runner.dispatches[0]!;
    expect(file).toBe("formic-agent.yml");
    expect(ref).toBe(base);
    // The ticket starts from the branch its pull request merges into: by
    // default the base branch itself, so there is nothing to bring up to date.
    expect(inputs).toMatchObject({ mode: "implement", ticket: "T-1", cli: "claude", from: base, secret });
    expect(runner.merges).toEqual([]);
    expect(inputs.prompt).toContain("Implement the ticket.");
    expect(inputs.prompt).toContain("src/lib/feature");
    expect(JSON.stringify(inputs)).not.toContain(TOKEN);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("running");
    expect(after.runnerJob).toBe(inputs.job);
  });

  it("keeps two accounts on the same CLI in separate secrets", async () => {
    const work = await assignClaudeCode("in_progress");
    const personal = await savePreset({
      name: "personal-claude",
      provider: "claude-code",
      model: "",
      prompt: "Review it.",
      apiKey: "sk-ant-oat01-personal-2222",
    });
    await repository().setColumnAgent(PROJECT, "backlog", personal.id);

    const a = (await cliAgentFor(PROJECT, "in_progress"))!;
    const b = (await cliAgentFor(PROJECT, "backlog"))!;
    expect(a.presetId).toBe(work.id);
    expect(secretNameFor(a)).not.toBe(secretNameFor(b));
  });

  it("refuses without a token", async () => {
    const preset = await assignClaudeCode();
    await savePreset({
      id: preset.id,
      name: preset.name,
      provider: "claude-code",
      model: "",
      prompt: "p",
      apiKey: null,
    });
    await installRunner();
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("no Claude Code token");
    expect(MockVcsClient.runner().dispatches).toHaveLength(0);
  });
});

describe("an agent out of usage", () => {
  it("takes no work until it resets, and a new key lifts it", async () => {
    const preset = await assignClaudeCode();
    await installRunner();
    await repository().setPresetLimit(preset.id, {
      until: new Date(Date.now() + 3_600_000),
      note: "Claude Code hit its usage limit.",
    });
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("my-claude is out of usage until");
    expect(MockVcsClient.runner().dispatches).toHaveLength(0);

    const saved = await savePreset({
      id: preset.id,
      name: preset.name,
      provider: "claude-code",
      model: "",
      prompt: "p",
      apiKey: "sk-ant-oat01-another-account-1111",
    });
    expect(saved.limitedUntil).toBeNull();
  });

});

describe("taking a CLI agent's work", () => {
  async function dispatched() {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    await runCoderAgent(PROJECT, ticket.id);
    const job = MockVcsClient.runner().dispatches[0]!.inputs.job!;
    return { ticket, job, staging: `${STAGING_PREFIX}${job}` };
  }

  /** Another ticket, running in `fileScope`: the files it needs are in use. */
  async function runningIn(epicId: string, fileScope: string[]) {
    const repo = repository();
    const [other] = await repo.createTickets([
      {
        epicId,
        key: "T-9",
        title: "Other work",
        description: "Other work.",
        acceptanceCriteria: ["It works"],
        fileScope,
        size: "M",
        position: 9,
        dependsOnKeys: [],
      },
    ]);
    await repo.updateTicket(other!.id, { status: "running" });
  }

  it("takes files outside the scope in when no running ticket uses them, and opens the pull request", async () => {
    const { ticket, job, staging } = await dispatched();
    MockVcsClient.stage(staging, ["src/lib/feature/a.ts", "package.json"], "T-1: stuff");

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.fileScope).toEqual(["package.json", "src/lib/feature"]);
    expect(after.prNumber).toBeGreaterThan(0);
  });

  it("opens the pull request from the staged work", async () => {
    const { ticket, job, staging } = await dispatched();
    const sha = MockVcsClient.stage(
      staging,
      ["src/lib/feature/thing.ts"],
      "T-1: Add the thing\n\nIt adds the thing.",
    );

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.prNumber).toBeGreaterThan(0);
    expect(after.summary).toBe("Add the thing");
    expect(after.runnerJob).toBeNull();
    const branches = MockVcsClient.runner().branches;
    expect(branches.get(after.branchName!)).toBe(sha);
    expect(branches.has(staging)).toBe(false);
  });

  it("takes a re-run's work onto the pull request that is still open", async () => {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    // Sent back to In Progress with its pull request from an earlier run open.
    const branch = "formic/t-1-earlier";
    const pull = await new MockVcsClient("acme/widgets").openPullRequest({
      headBranch: branch,
      baseBranch: "formic/integration",
      title: "T-1: first try",
      body: "",
    });
    await repository().updateTicket(ticket.id, { branchName: branch, prNumber: pull.number, prUrl: pull.url });

    await runCoderAgent(PROJECT, ticket.id);
    const inputs = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    // It builds on that branch, so its work is a fast-forward of it.
    expect(inputs.from).toBe(branch);

    const sha = MockVcsClient.stage(`${STAGING_PREFIX}${inputs.job}`, ["src/lib/feature/thing.ts"], "T-1: Do it again");
    await completeCliRun(PROJECT, { job: inputs.job!, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after).toMatchObject({ prNumber: pull.number, runnerJob: null, summary: "Do it again" });
    expect(after.status).not.toBe("running");
    expect(MockVcsClient.runner().branches.get(branch)).toBe(sha);
  });

  it("lands carried workflow changes in place, judged by their real paths", async () => {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket(["src/lib/feature", ".github/workflows"]);
    await runCoderAgent(PROJECT, ticket.id);
    const job = MockVcsClient.runner().dispatches[0]!.inputs.job!;
    const staged = MockVcsClient.stage(
      `${STAGING_PREFIX}${job}`,
      ["src/lib/feature/a.ts", ".formic/carry/.github/workflows/ci.yml", CARRY_DELETED],
      "T-1: Change CI",
    );
    MockVcsClient.runner().files.set(`${staged}:${CARRY_DELETED}`, ".github/workflows/old.yml\n");

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.prNumber).toBeGreaterThan(0);
    const head = MockVcsClient.runner().branches.get(after.branchName!)!;
    expect(head).not.toBe(staged);
    expect(MockVcsClient.runner().commits.get(head)!.files.sort()).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/old.yml",
      "src/lib/feature/a.ts",
    ]);
  });

  it("holds carried workflow changes to the file scope too", async () => {
    const { ticket, job, staging } = await dispatched();
    await runningIn(ticket.epicId, [".github"]);
    MockVcsClient.stage(staging, ["src/lib/feature/a.ts", ".formic/carry/.github/workflows/ci.yml"], "T-1: stuff");

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain(".github/workflows/ci.yml");
    expect(after.blockedReason).not.toContain(".formic/carry");
  });

  it("keeps work outside the file scope on the ticket's branch and asks, when a running ticket uses the files", async () => {
    const { ticket, job, staging } = await dispatched();
    await runningIn(ticket.epicId, ["package.json"]);
    const sha = MockVcsClient.stage(staging, ["src/lib/feature/a.ts", "package.json"], "T-1: stuff");

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after).toMatchObject({ status: "blocked", stalledIn: "todo", scopeRequest: ["package.json"] });
    expect(after.blockedReason).toContain("package.json");
    expect(after.prNumber).toBeNull();
    const branches = MockVcsClient.runner().branches;
    expect(branches.get(after.branchName!)).toBe(sha);
    expect(branches.has(staging)).toBe(false);
  });

  it("parks the card with the log link when the run fails", async () => {
    const { ticket, job } = await dispatched();

    await completeCliRun(PROJECT, {
      job,
      mode: "implement",
      conclusion: "failure",
      url: "https://github.com/acme/widgets/actions/runs/1",
    });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("failed");
    expect(after.blockedReason).toContain("actions/runs/1");
  });

  it("says why the run failed, from its log, and marks a limited agent out until it resets", async () => {
    const { ticket, job } = await dispatched();
    const url = "https://github.com/acme/widgets/actions/runs/2";
    MockVcsClient.runner().logs.set(
      url,
      [
        "2026-09-23T15:40:38.4614765Z ##[group]Run set -euo pipefail",
        "2026-09-23T15:40:38.4716567Z   PROMPT: Handle the rate limit",
        "2026-09-23T15:40:38.4744084Z ##[endgroup]",
        "2026-09-23T15:41:32.5220071Z You've hit your session limit · resets 6:30pm (UTC)",
        "2026-09-23T15:41:32.7166259Z ##[error]Process completed with exit code 1.",
      ].join("\n"),
    );

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "failure", url });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("failed");
    expect(after.blockedReason).toContain("Claude Code hit its usage limit");
    expect(after.blockedReason).toContain(url);

    const presetId = (await repository().columnAgents(PROJECT)).in_progress!;
    const { preset } = (await repository().presetForRun(presetId))!;
    expect(preset.limitedUntil).toBe("2026-09-23T18:30:00.000Z");
  });

  it("does not blame the plan for a failure the log never said was one", async () => {
    // Run 36642551420: an agent three turns into the scope-request ticket read
    // Formic's own `card-actions.test.ts`, whose fixture quotes "Claude Code
    // hit its usage limit", while the run was dying on Cline's gateway. The
    // card said the plan was spent; the log said this, on its last line.
    const { ticket, job } = await dispatched();
    const url = "https://github.com/acme/widgets/actions/runs/4";
    MockVcsClient.runner().logs.set(
      url,
      [
        "2026-09-29T22:59:40.0000000Z ##[group]Run set -euo pipefail",
        "2026-09-29T22:59:40.1000000Z   PROMPT: Resolve a ticket's scope-request block.",
        "2026-09-29T22:59:40.2000000Z ##[endgroup]",
        JSON.stringify({
          type: "run.log",
          runId: "r",
          stream: "stdout",
          line: '      blockedReason: "Claude Code hit its usage limit.",',
        }),
        '2026-09-29T22:59:52.2819259Z ClinePass error 500: {"error":"empty response content","success":false}',
        "2026-09-29T22:59:56.3309577Z The loop stopped (exit 1).",
        "2026-09-29T22:59:56.5000000Z ##[error]Process completed with exit code 1.",
      ].join("\n"),
    );

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "failure", url });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.blockedReason).toContain("empty response content");
    expect(after.blockedReason).not.toContain("usage limit");
  });

  it("blames the agent the run actually used, not whichever one the column runs now", async () => {
    const original = await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    await runCoderAgent(PROJECT, ticket.id);
    const job = MockVcsClient.runner().dispatches[0]!.inputs.job!;

    // A person swaps the column's agent while this run is still out on GitHub
    // Actions, before its failure is ever processed.
    const swapped = await savePreset({
      name: "second-account",
      provider: "claude-code",
      model: "",
      prompt: "Implement the ticket.",
      apiKey: "another-token",
    });
    await repository().setColumnAgent(PROJECT, "in_progress", swapped.id);

    const url = "https://github.com/acme/widgets/actions/runs/9";
    MockVcsClient.runner().logs.set(
      url,
      [
        "2026-09-23T15:40:38.4614765Z ##[group]Run set -euo pipefail",
        "2026-09-23T15:40:38.4716567Z   PROMPT: Handle the rate limit",
        "2026-09-23T15:40:38.4744084Z ##[endgroup]",
        "2026-09-23T15:41:32.5220071Z You've hit your session limit · resets 6:30pm (UTC)",
        "2026-09-23T15:41:32.7166259Z ##[error]Process completed with exit code 1.",
      ].join("\n"),
    );

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "failure", url });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.blockedReason).toContain("Claude Code hit its usage limit");

    const originalAfter = (await repository().presetForRun(original.id))!.preset;
    expect(originalAfter.limitedUntil).toBe("2026-09-23T18:30:00.000Z");

    const swappedAfter = (await repository().presetForRun(swapped.id))!.preset;
    expect(swappedAfter.limitedUntil).toBeNull();
  });

  it("quotes the agent's last words when the failure is not one it knows", async () => {
    const { ticket, job } = await dispatched();
    const url = "https://github.com/acme/widgets/actions/runs/3";
    MockVcsClient.runner().logs.set(
      url,
      "##[group]Run x\n##[endgroup]\nError: ENOSPC: no space left on device\n##[error]Process completed with exit code 1.",
    );

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "failure", url });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.blockedReason).toContain("ENOSPC: no space left on device");
  });

  it("closes a ticket that was already done, with no pull request", async () => {
    const { ticket, job, staging } = await dispatched();
    MockVcsClient.stage(
      staging,
      [],
      "T-1: The thing is already there\n\nIt is done: src/lib/feature/thing.ts does it.\n\nFormic-Already-Done: true",
    );

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("merged");
    expect(after.prNumber).toBeNull();
    expect(after.summary).toBe("Already done: The thing is already there");
    expect(MockVcsClient.runner().branches.has(staging)).toBe(false);
  });

  it("sends a re-run that finds its own open pull request's work back to review, not Done", async () => {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    const branch = "formic/t-1-earlier";
    const pull = await new MockVcsClient("acme/widgets").openPullRequest({
      headBranch: branch,
      baseBranch: "formic/integration",
      title: "T-1: first try",
      body: "",
    });
    await repository().updateTicket(ticket.id, { branchName: branch, prNumber: pull.number, prUrl: pull.url });

    await runCoderAgent(PROJECT, ticket.id);
    const job = MockVcsClient.runner().dispatches.at(-1)!.inputs.job!;
    MockVcsClient.stage(
      `${STAGING_PREFIX}${job}`,
      [],
      `T-1: The thing is already there\n\nIt is done on this branch.\n\n${ALREADY_DONE_TRAILER}`,
    );

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("review");
    expect(after.prNumber).toBe(pull.number);
  });

  it("still stops on an empty run that does not say it was already done", async () => {
    const { ticket, job, staging } = await dispatched();
    MockVcsClient.stage(staging, [], "T-1: nothing");

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    expect((await repository().ticketDetail(ticket.id))!.status).toBe("failed");
  });

  it("tells the agent how to report a ticket that is already done", async () => {
    await dispatched();
    const prompt = MockVcsClient.runner().dispatches[0]!.inputs.prompt!;
    expect(prompt).toContain("Formic-Already-Done: true");
    expect(prompt).toContain("--allow-empty");
  });

  it("ignores a result nobody is waiting for", async () => {
    const { ticket, staging } = await dispatched();
    const stale = `${ticket.id}--oldjob00`;
    MockVcsClient.stage(`${STAGING_PREFIX}${stale}`, ["src/lib/feature/a.ts"], "T-1: old");
    MockVcsClient.stage(staging, ["src/lib/feature/a.ts"], "T-1: new");

    await completeCliRun(PROJECT, { job: stale, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("running");
    expect(after.prNumber).toBeNull();
    expect(MockVcsClient.runner().branches.has(`${STAGING_PREFIX}${stale}`)).toBe(false);
  });
});

describe("a CLI agent resolving a conflict", () => {
  /** A conflicted pull request, handed to the In Review agent in Actions. */
  async function conflicted() {
    await assignClaudeCode("in_review");
    await installRunner();
    const ticket = await seedTicket();
    const client = new MockVcsClient("acme/widgets");
    setVcs(client);
    const pull = await client.openPullRequest({
      headBranch: "formic/t-1-abc",
      baseBranch: "main",
      title: "T-1",
      body: "",
    });
    await repository().updateTicket(ticket.id, {
      status: "review",
      prNumber: pull.number,
      branchName: pull.headBranch,
    });
    MockVcsClient.runner().branches.set(pull.headBranch, pull.headSha);
    MockVcsClient.setPull(pull.number, { mergeable: false });

    await reviewPullRequest(PROJECT, pull.number, pull.headSha);

    const job = (await repository().ticketDetail(ticket.id))!.runnerJob!;
    // What main brought since the branch was cut.
    const merged = MockVcsClient.stage("formic-test/main", ["src/other/brought.ts"], "main's work");
    return { ticket, pull, job, merged };
  }

  it("merges the base in first and asks the agent to resolve it, instead of parking the card", async () => {
    const { ticket, job } = await conflicted();

    const inputs = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    expect(inputs).toMatchObject({ mode: "fix", merge: "main", from: "formic/t-1-abc" });
    expect(inputs.prompt).toContain("conflicts with main");
    expect(inputs.prompt).toContain("Do not commit");
    expect(job).toBeTruthy();
    expect((await repository().ticketDetail(ticket.id))!.status).toBe("review");
  });

  it("records the resolution as the merge, holding only the agent's own change to the scope", async () => {
    const { ticket, job, merged } = await conflicted();
    MockVcsClient.stage(
      `${STAGING_PREFIX}${job}`,
      ["src/lib/feature/a.ts", "src/other/brought.ts"],
      `T-1: bring main in\n\nKept both sides.\n\nFormic-Merged: ${merged}`,
    );

    await completeCliRun(PROJECT, { job, mode: "fix", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    const head = MockVcsClient.runner().branches.get("formic/t-1-abc")!;
    expect(after.status).toBe("review");
    expect(MockVcsClient.runner().recordedMerges.get(head)).toBe(merged);
    expect(after.reviewedSha).toBe(head);
  });

  it("refuses a resolution that changes files neither side brought, outside the scope", async () => {
    const { ticket, job, merged } = await conflicted();
    MockVcsClient.stage(
      `${STAGING_PREFIX}${job}`,
      ["src/lib/feature/a.ts", "src/elsewhere/z.ts"],
      `T-1: bring main in\n\nFormic-Merged: ${merged}`,
    );

    await completeCliRun(PROJECT, { job, mode: "fix", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("src/elsewhere/z.ts");
    expect(MockVcsClient.runner().recordedMerges.size).toBe(0);
  });

  it("reads which commit a run merged in from its trailer", () => {
    const sha = "a".repeat(40);
    expect(mergedFrom([`T-1: x\n\nbody\n\nFormic-Merged: ${sha}\n`])).toBe(sha);
    expect(mergedFrom(["T-1: x\n\nFormic-Merged: not-a-sha"])).toBeNull();
    expect(mergedFrom([])).toBeNull();
  });
});

describe("a CLI agent fixing red CI", () => {
  it("fast-forwards the pull request's branch with the fix", async () => {
    await assignClaudeCode("in_review");
    const ticket = await seedTicket();
    const job = `${ticket.id}--fix00001`;
    const branch = "formic/t-1-abc";
    await repository().updateTicket(ticket.id, {
      status: "review",
      prNumber: 5,
      branchName: branch,
      runnerJob: job,
    });
    const sha = MockVcsClient.stage(`${STAGING_PREFIX}${job}`, ["src/lib/feature/a.ts"], "T-1: fix");

    await completeCliRun(PROJECT, { job, mode: "fix", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("review");
    expect(after.runnerJob).toBeNull();
    expect(MockVcsClient.runner().branches.get(branch)).toBe(sha);
    // The reviewer vouches for its own fix: green CI on it merges.
    expect(after.reviewedSha).toBe(sha);
  });

  /** A CLI reviewer that changed nothing and said why, on an open pull request. */
  async function reviewed(verdict: string) {
    await assignClaudeCode("in_review");
    const ticket = await seedTicket();
    const client = new MockVcsClient("acme/widgets");
    setVcs(client);
    const pull = await client.openPullRequest({
      headBranch: "formic/t-1-abc",
      baseBranch: "main",
      title: "T-1",
      body: "",
    });
    const job = `${ticket.id}--rev00001`;
    await repository().updateTicket(ticket.id, {
      status: "review",
      prNumber: pull.number,
      branchName: pull.headBranch,
      runnerJob: job,
    });
    MockVcsClient.runner().branches.set(pull.headBranch, pull.headSha);
    MockVcsClient.stage(`${STAGING_PREFIX}${job}`, [], `T-1: review\n\n${verdict}`);
    await completeCliRun(PROJECT, { job, mode: "fix", conclusion: "success", url: null });
    return { ticket, pull };
  }

  it("merges a pull request the reviewer approved", async () => {
    const { ticket, pull } = await reviewed("Every criterion is met.\n\nFormic-Review: approved");
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.reviewedSha).toBe(pull.headSha);
    expect(after.status).toBe("merged");
  });

  it("sends a ticket back to the Coder Agent with the reviewer's reason", async () => {
    const { ticket } = await reviewed("The export ignores archived cards.\n\nFormic-Review: send-back");
    const notes = (await repository().ticketEvents(PROJECT, ticket.id, ["ticket.note"], 10)).map(
      (e) => (e.payload as { text: string }).text,
    );
    expect(notes.at(-1)).toBe("Sent back by review: The export ignores archived cards.");
    expect((await repository().ticketDetail(ticket.id))!.status).not.toBe("merged");
  });

  it("tells the reviewer how to approve or send back", async () => {
    const { ticket } = await reviewed("Formic-Review: approved");
    const prompt = cliPrompt(
      (await cliAgentFor(PROJECT, "in_review"))!,
      "fix",
      ticket,
      { baseBranch: "main", changedFiles: ["src/lib/feature/a.ts"], checks: [], attempt: 1, maxAttempts: 3 },
    );
    expect(prompt).toContain("Formic-Review: approved");
    expect(prompt).toContain("Formic-Review: send-back");
    expect(prompt).toContain("whatever the ticket says");
    expect(prompt).toContain("CI is green on this head.");
    expect(prompt).toContain(PLAN_FIRST_RULE);
  });
});

describe("reading a CLI reviewer's verdict", () => {
  it("takes the last trailer, and nothing without one", () => {
    expect(reviewVerdictOf(["T-1: review\n\nFine.\nFormic-Review: approved"])).toBe("approved");
    expect(reviewVerdictOf(["T-1: review\n\nformic-review: Send-Back"])).toBe("send-back");
    expect(reviewVerdictOf(["T-1: changes from the agent"])).toBeNull();
  });
});

describe("collecting a run whose webhook never came", () => {
  /** Lets the next collection look again, past its 15-second throttle. */
  async function collectLater() {
    vi.useFakeTimers({ now: Date.now() + 60_000 * ++minutes, toFake: ["Date"] });
    try {
      await collectCliRuns(PROJECT);
    } finally {
      vi.useRealTimers();
    }
  }
  let minutes = 0;

  it("takes a ticket's finished work on its own", async () => {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    await runCoderAgent(PROJECT, ticket.id);
    const job = MockVcsClient.runner().dispatches[0]!.inputs.job!;
    MockVcsClient.stage(`${STAGING_PREFIX}${job}`, ["src/lib/feature/a.ts"], "T-1: Add it");

    // Still running: nothing moves.
    MockVcsClient.runner().runs.set(runTitle("implement", "T-1", job), {
      status: "in_progress",
      conclusion: null,
      url: "https://github.com/acme/widgets/actions/runs/40",
    });
    await collectLater();
    expect((await repository().ticketDetail(ticket.id))!.prNumber).toBeNull();

    MockVcsClient.runner().runs.set(runTitle("implement", "T-1", job), {
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/widgets/actions/runs/40",
    });
    await collectLater();
    expect((await repository().ticketDetail(ticket.id))!.prNumber).toBeGreaterThan(0);

    // The late webhook for the same run then does nothing.
    const [signal] = interpret("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 40,
        path: RUNNER_WORKFLOW_PATH,
        display_title: runTitle("implement", "T-1", job),
        conclusion: "success",
        html_url: "https://github.com/acme/widgets/actions/runs/40",
      },
    });
    expect(await repository().claimDelivery(signal!.key)).toBe(false);
  });

  it("takes an Epic's failed planning run on its own, and saves why", async () => {
    await assignClaudeCode("backlog");
    await installRunner();
    const epic = await repository().createEpic({
      projectId: PROJECT,
      title: "Export",
      rawRequest: "Export",
      position: 1,
    });
    await runProductAgent(PROJECT, epic.id, "Export");
    const job = MockVcsClient.runner().dispatches.at(-1)!.inputs.job!;
    MockVcsClient.runner().runs.set(runTitle("product", "EPIC-1", job), {
      status: "completed",
      conclusion: "timed_out",
      url: "https://github.com/acme/widgets/actions/runs/41",
    });

    await collectLater();

    const card = (await repository().cardById(epic.id))!;
    expect(card).toMatchObject({ status: "failed", stalledIn: "backlog" });
    expect(card.blockedReason).toContain("time limit");
  });
});

describe("the runner workflow", () => {
  it("is versioned by its own content, so no two changes can share a version", async () => {
    const { version, workflow } = await currentRunnerFiles();
    expect(version).toMatch(/^formic-runner: [0-9a-f]{12}$/);
    expect(workflow.startsWith(`# ${version}\n`)).toBe(true);
  });

  it("is versioned on the loop entry it installs with, so the pair is one version", async () => {
    const { workflow } = await currentRunnerFiles();
    // The entry a repository must carry is named in the workflow, and the
    // version hashes that name: a repository with one file and not the other,
    // or with an older pair, is not the version this board installs.
    expect(workflow).toContain("# formic-loop-entry: ");
    expect(runnerWorkflow("abcdef123456")).not.toBe(runnerWorkflow(null));
  });

  it("merges another branch in before the agent starts, when asked, leaving its conflicts", () => {
    const yaml = runnerWorkflow(null);
    expect(yaml).toContain("merge --no-commit --no-ff");
    expect(yaml).toContain("fetch-depth: ${{ inputs.merge != '' && '0' || '2' }}");
    expect(yaml).toContain("Conflict markers are still in the change.");
  });

  it("never splices inputs into a script", () => {
    const yaml = runnerWorkflow(null);
    for (const line of yaml.split("\n")) {
      if (!line.includes("${{ inputs.")) continue;
      // Allowed: env values, the checkout's ref and depth, the title and the concurrency key.
      expect(line).toMatch(/^\s+([A-Z_]+|ref|fetch-depth|group):\s|^run-name:/);
    }
    expect(yaml).toContain("persist-credentials: false");
  });

  it("round-trips its title, which is how its result finds the card", () => {
    expect(parseRunTitle(runTitle("fix", "T-12", "abc--1234"))).toEqual({
      mode: "fix",
      ticketKey: "T-12",
      job: "abc--1234",
    });
    expect(parseRunTitle(runTitle("architect", "E-3", "epc--1234-2"))).toEqual({
      mode: "architect",
      ticketKey: "E-3",
      job: "epc--1234-2",
    });
  });

  it("streams the agent's output to Formic and hands Claude Code notes through a hook", () => {
    const yaml = runnerWorkflow(null);
    expect(yaml).toContain("--output-format stream-json --verbose");
    expect(yaml).toContain('--settings "$RUNNER_TEMP/formic-hooks.json"');
    expect(yaml).toContain("exec --json --output-last-message");
    expect(yaml).toContain('python3 "$RUNNER_TEMP/formic-report.py" &');
    // The reporter's script sits at the block's own indent, as Python needs.
    expect(yaml).toMatch(/\n {10}import base64, hashlib, json, os, subprocess, time, urllib.request\n/);
  });

  it("keeps only the answer from a planning run", () => {
    const yaml = runnerWorkflow(null);
    expect(yaml).toContain("product|architect|showcase|ask)");
    expect(yaml).toContain('git reset -q --hard "$FORMIC_START"');
    expect(yaml).toContain(`git add -f "${ANSWER_PATH}"`);
  });

  it("makes room for downloaded attachments and names it for the agent", () => {
    const yaml = runnerWorkflow(null);
    expect(yaml).toContain('mkdir -p "$RUNNER_TEMP/formic-attachments"');
    expect(yaml).toContain("FORMIC_ATTACHMENTS: ${{ runner.temp }}/formic-attachments");
  });

  it("reports back as a runner signal, not as CI", () => {
    // As GitHub sends it: a run's name is its run-name, not the workflow's.
    const title = runTitle("implement", "T-1", "tkt--abcd1234");
    const signals = interpret("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 7,
        name: title,
        path: RUNNER_WORKFLOW_PATH,
        display_title: title,
        conclusion: "success",
        html_url: "https://github.com/acme/widgets/actions/runs/7",
        head_sha: "deadbeef",
        pull_requests: [{ number: 3 }],
      },
    });
    expect(signals).toEqual([
      {
        kind: "runner",
        job: "tkt--abcd1234",
        mode: "implement",
        conclusion: "success",
        url: "https://github.com/acme/widgets/actions/runs/7",
        key: "runner:tkt--abcd1234:7",
      },
    ]);
  });

  it("reopens the setup pull request when an older runner version is installed", async () => {
    await assignClaudeCode();
    const base = (await projectFor(PROJECT)).baseBranch;
    await new MockVcsClient("acme/widgets").commitFile(
      base,
      RUNNER_WORKFLOW_PATH,
      "# formic-runner: v1\nname: Formic agent\n",
      "install an old copy",
    );
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.blockedReason).toMatch(
      /GitHub Actions\. Merge the setup pull request once \(https:\/\/\S+\), then try again\.$/,
    );
    const runner = MockVcsClient.runner();
    const { branch, version } = await currentRunnerFiles();
    expect(runner.files.get(`${branch}:${RUNNER_WORKFLOW_PATH}`)).toContain(version);
  });
});

describe("signed attachment URLs for a CLI agent with no Formic session", () => {
  it("signs a URL that verifies, and refuses another attachment's id or a wrong token", () => {
    vi.stubEnv("FORMIC_URL", "https://formic.example");
    const url = signedAttachmentUrl("att_1")!;
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://formic.example/api/attachments/att_1");
    const expires = parsed.searchParams.get("expires")!;
    const token = parsed.searchParams.get("token")!;

    expect(attachmentUrlAllowed("att_1", expires, token)).toBe(true);
    expect(attachmentUrlAllowed("att_2", expires, token)).toBe(false);
    expect(attachmentUrlAllowed("att_1", expires, "0".repeat(64))).toBe(false);
  });

  it("refuses a URL past its expiry", () => {
    vi.stubEnv("FORMIC_URL", "https://formic.example");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const url = signedAttachmentUrl("att_1")!;
      const parsed = new URL(url);
      const expires = parsed.searchParams.get("expires")!;
      const token = parsed.searchParams.get("token")!;
      expect(attachmentUrlAllowed("att_1", expires, token)).toBe(true);

      vi.setSystemTime(Number(expires) + 1);
      expect(attachmentUrlAllowed("att_1", expires, token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no URL to sign without a public origin", () => {
    vi.stubEnv("FORMIC_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    expect(signedAttachmentUrl("att_1")).toBeNull();
  });
});

describe("a CLI agent seen while it works", () => {
  async function dispatched() {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    await runCoderAgent(PROJECT, ticket.id);
    const inputs = MockVcsClient.runner().dispatches[0]!.inputs;
    return { ticket, job: inputs.job!, inputs };
  }

  const line = (event: unknown) => JSON.stringify(event);

  it("hands the workflow an address to report to, only when the board has one", async () => {
    vi.stubEnv("FORMIC_URL", "https://formic.example/");
    const { job, inputs } = await dispatched();
    const url = new URL(inputs.report!);
    expect(url.origin + url.pathname).toBe("https://formic.example/api/runner/report");
    expect(url.searchParams.get("job")).toBe(job);
    const since = url.searchParams.get("since")!;
    expect(reportAllowed(job, since, url.searchParams.get("token")!)).toBe(true);
    expect(reportAllowed("other--job", since, url.searchParams.get("token")!)).toBe(false);
    expect(reportAllowed(job, since, "0".repeat(64))).toBe(false);
  });

  it("leaves the address empty on a board with no public one", async () => {
    vi.stubEnv("FORMIC_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    const { inputs } = await dispatched();
    expect(inputs.report).toBe("");
  });

  it("shows what it thinks, does and plans on the ticket, and hands it the person's notes", async () => {
    const { ticket, job } = await dispatched();
    const since = Date.now() - 1_000;
    const before = await repository().ticketEvents(PROJECT, ticket.id, ["run.thought", "run.progress"]);

    await addNote(PROJECT, ticket.id, "Use the memory repository first.");
    const reply = await receiveReport({
      job,
      since,
      after: 0,
      lines: [
        line({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Reading the repository first." },
              { type: "tool_use", id: "a", name: "Read", input: { file_path: "src/lib/db/repository.ts" } },
              {
                type: "tool_use",
                id: "b",
                name: "TodoWrite",
                input: { todos: [{ content: "Add the model", status: "in_progress" }] },
              },
            ],
          },
        }),
      ],
    });

    expect(reply.stop).toBe(false);
    expect(reply.notes.map((n) => n.text)).toEqual(["Use the memory repository first."]);
    const events = (await repository().ticketEvents(PROJECT, ticket.id, ["run.thought", "run.progress"])).slice(
      before.length,
    );
    expect(events.map((e) => e.payload)).toMatchObject([
      { type: "run.thought", kind: "text", text: "Reading the repository first." },
      { type: "run.progress", label: "Reading src/lib/db/repository.ts" },
    ]);
    expect((await repository().ticketDetail(ticket.id))!.plan).toEqual([
      { step: "Add the model", status: "in_progress" },
    ]);

    // A note it has been sent is not sent again.
    const again = await receiveReport({ job, since, after: reply.notes[0]!.seq, lines: [] });
    expect(again.notes).toEqual([]);
  });

  it("shows an assistant question's output in the terminal while it is pending, and stops once it is not", async () => {
    const msg = await repository().addAssistantMessage({
      projectId: PROJECT,
      role: "assistant",
      content: "",
      status: "pending",
    });
    const job = `${msg.id}--ask-1`;
    await repository().updateAssistantMessage(msg.id, { runnerJob: job });
    const before = (await repository().eventsAfter(PROJECT, 0)).length;

    for (const text of ["reading the board", "still reading"]) {
      const reply = await receiveReport({ job, since: Date.now(), after: 0, lines: [text] });
      expect(reply.stop).toBe(false);
    }
    const events = (await repository().eventsAfter(PROJECT, 0)).slice(before);
    expect(events.map((e) => e.payload)).toMatchObject([
      { type: "run.log", runId: job, line: "reading the board" },
      { type: "run.log", runId: job, line: "still reading" },
    ]);

    await repository().updateAssistantMessage(msg.id, { status: "done" });
    expect((await receiveReport({ job, since: Date.now(), after: 0, lines: ["late"] })).stop).toBe(true);
  });

  describe("checkpoints", () => {
    const BASE = "a".repeat(40);
    const checkpoint = {
      base: BASE,
      files: [{ path: "src/lib/feature/a.ts", mode: "100644" as const, content: Buffer.from("x\n").toString("base64") }],
      deleted: ["src/lib/feature/old.ts"],
      note: "The drop zone has to be mounted before the drag starts.",
    };
    const saved = (ticketId: string) => MockVcsClient.runner().checkpoints.get(ticketId);

    it("saves the run's work in progress, with its notes, as the ticket's checkpoint", async () => {
      const { ticket, job } = await dispatched();

      const reply = await receiveReport({ job, since: Date.now(), after: 0, lines: [], checkpoint });

      expect(reply.checkpointed).toBe(true);
      expect(saved(ticket.id)).toMatchObject({ parent: BASE, input: { files: checkpoint.files, deleted: checkpoint.deleted } });
      expect(saved(ticket.id)!.message).toBe(
        `T-1: checkpoint\n\n${checkpoint.note}\n\n${CHECKPOINT_TRAILER} ${job}`,
      );
    });

    it("takes no checkpoint from a run nobody waits on", async () => {
      const { ticket, job } = await dispatched();
      await repository().updateTicket(ticket.id, { runnerJob: null });

      await receiveReport({ job, since: Date.now(), after: 0, lines: [], checkpoint });

      expect(saved(ticket.id)).toBeUndefined();
    });

    it("carries the next run on from the checkpoint, told where the last one got to", async () => {
      const { ticket, job } = await dispatched();
      await receiveReport({ job, since: Date.now(), after: 0, lines: [], checkpoint });
      await repository().updateTicket(ticket.id, {
        plan: [
          { step: "Add the status", status: "done" },
          { step: "Wire the drop zone", status: "in_progress" },
        ],
      });
      await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "cancelled", url: null });
      expect(saved(ticket.id)).toBeDefined();

      await runCoderAgent(PROJECT, ticket.id);

      const retry = MockVcsClient.runner().dispatches.at(-1)!.inputs;
      expect(retry.job).not.toBe(job);
      expect(retry.from).toBe(saved(ticket.id)!.sha);
      expect(retry.prompt).toContain("Carrying on.");
      expect(retry.prompt).toContain("- [x] Add the status\n- [ ] Wire the drop zone");
      expect(retry.prompt).toContain(checkpoint.note);
    });

    it("drops the checkpoint once the run's work is taken", async () => {
      const { ticket, job, } = await dispatched();
      await receiveReport({ job, since: Date.now(), after: 0, lines: [], checkpoint });
      MockVcsClient.stage(`${STAGING_PREFIX}${job}`, ["src/lib/feature/a.ts"], "T-1: Add it");

      await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

      expect((await repository().ticketDetail(ticket.id))!.prNumber).toBeGreaterThan(0);
      expect(saved(ticket.id)).toBeUndefined();
    });

    it("drops a checkpoint its branch has moved on from, and starts on the branch", async () => {
      await assignClaudeCode();
      await installRunner();
      const ticket = await seedTicket();
      await repository().updateTicket(ticket.id, { prNumber: 7, branchName: "formic/t-1" });
      MockVcsClient.runner().branches.set("formic/t-1", "b".repeat(40));
      await new MockVcsClient("acme/widgets").saveCheckpoint(ticket.id, {
        base: BASE,
        files: [],
        deleted: [],
        message: `T-1: checkpoint\n\n${CHECKPOINT_TRAILER} old`,
      });

      await runCoderAgent(PROJECT, ticket.id);

      expect(MockVcsClient.runner().dispatches.at(-1)!.inputs.from).toBe("formic/t-1");
      expect(saved(ticket.id)).toBeUndefined();
    });
  });

  it("tells a run nobody waits on any more to stop reporting", async () => {
    const { ticket, job } = await dispatched();
    await repository().updateTicket(ticket.id, { runnerJob: null });
    expect(await receiveReport({ job, since: Date.now(), after: 0, lines: [] })).toEqual({ notes: [], stop: true });
  });

  it("stops: the card stalls, the run is cancelled, and what it hands back is thrown away", async () => {
    const { ticket, job } = await dispatched();
    const title = runTitle("implement", "T-1", job);
    MockVcsClient.runner().runs.set(title, {
      status: "in_progress",
      conclusion: null,
      url: "https://github.com/acme/widgets/actions/runs/77",
    });

    expect(await stopTicket(PROJECT, ticket.id)).toBe(true);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after).toMatchObject({ status: "blocked", stalledIn: "in_progress", runnerJob: null });
    expect(after.blockedReason).toBe(STOPPED_BY_PERSON);
    expect(MockVcsClient.runner().runs.get(title)).toMatchObject({ status: "completed", conclusion: "cancelled" });

    MockVcsClient.stage(`${STAGING_PREFIX}${job}`, ["src/lib/feature/a.ts"], "T-1: Add it");
    await completeCliRun(PROJECT, {
      job,
      mode: "implement",
      conclusion: "success",
      url: "https://github.com/acme/widgets/actions/runs/77",
    });
    expect((await repository().ticketDetail(ticket.id))!.prNumber).toBeNull();

    // Nothing left to stop.
    expect(await stopTicket(PROJECT, ticket.id)).toBe(false);
  });

  async function reportShown(message: string): Promise<string> {
    const { ticket, job } = await dispatched();
    MockVcsClient.stage(`${STAGING_PREFIX}${job}`, ["src/lib/feature/a.ts"], message);
    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });
    const events = await repository().ticketEvents(PROJECT, ticket.id, ["run.thought"]);
    return (events.at(-1)?.payload as { text?: string } | undefined)?.text ?? "";
  }

  it("shows the agent's whole report", async () => {
    // AUD-02's report was 4,006 characters and lost its last word.
    const report = `T-1: Add it\n\n${"x".repeat(3_990)} full test suite`;
    expect(await reportShown(report)).toBe(report);
  });

  it("says so when a report is too long to show whole", async () => {
    const report = `T-1: Add it\n\n${"y".repeat(30_000)}`;
    const shown = await reportShown(report);
    expect(shown.length).toBeLessThan(report.length);
    expect(shown).toContain("[Cut short here. The full report is on the pull request.]");
  });

  it("briefs every later run with the person's notes", async () => {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    await addNote(PROJECT, ticket.id, "Keep the old API working.");
    await runCoderAgent(PROJECT, ticket.id);
    expect(MockVcsClient.runner().dispatches[0]!.inputs.prompt).toContain("- Keep the old API working.");
  });
});

describe("an API-key coder running in a job", () => {
  const API_KEY = "sk-deepseek-key-1234";

  async function assignApiAgent(column: ColumnId = "in_progress") {
    const preset = await savePreset({
      name: "my-deepseek",
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      prompt: "Implement the ticket.",
      apiKey: API_KEY,
    });
    await repository().setColumnAgent(PROJECT, column, preset.id);
    return preset;
  }

  it("runs the same column in a job when the repository's workflow can", async () => {
    vi.stubEnv("FORMIC_URL", "https://formic.example");
    const preset = await assignApiAgent();
    const base = await installRunner();
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const runner = MockVcsClient.runner();
    const secret = secretNameFor({ presetId: preset.id, info: provider("deepseek")! });
    expect(secret).toMatch(/^FORMIC_API_KEY_DEEPSEEK_[A-Z0-9_]+$/);
    expect(runner.secrets.get(secret)).toBe(API_KEY);

    const { inputs } = runner.dispatches[0]!;
    expect(inputs).toMatchObject({ mode: "loop", cli: "loop", ticket: "T-1", from: base, secret });
    // The entry is fetched from the board, signed for this one job.
    expect(inputs.bundle).toContain("https://formic.example/api/runner/bundle?");
    expect(inputs.bundle).toContain(`job=${inputs.job}`);
    // The key is never in the payload: the job reads it from the repository's
    // secrets, so the run's own event never carries it.
    expect(JSON.stringify(inputs)).not.toContain(API_KEY);

    const payload = JSON.parse(inputs.prompt!) as {
      provider: string;
      model: string;
      repo: Record<string, unknown>;
      ticket: { key: string; fileScope: string[] };
      limits: { maxDurationMs: number; budgetMs: number };
    };
    expect(payload).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      repo: { fullName: (await projectFor(PROJECT)).repoFullName, baseBranch: base },
      ticket: { key: "T-1", fileScope: ["src/lib/feature"] },
    });
    // Three story points at ten minutes each: the ticket's own budget is the
    // plan, and the job's 180 minutes is the backstop.
    expect(payload.limits.maxDurationMs).toBe(30 * 60_000);
    expect(payload.limits.budgetMs).toBe(30 * 60_000);
    expect(payload).not.toHaveProperty("apiKey");

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("running");
    expect(after.runnerJob).toBe(inputs.job);
  });

  describe("budgets the run from the starting person's setting", () => {
    async function ownProject(settings: RunTimeBudgetSettings) {
      await projectFor(PROJECT);
      const user = await repository().upsertUser({ githubId: 1, login: "ada", name: null, avatarUrl: null });
      await repository().adoptUnowned(user.id);
      await updateRunTimeBudgetSettings(user.id, settings);
      return user.id;
    }

    /** Starts a run on a ticket of this size. */
    async function startRun(storyPoints: number): Promise<TicketDetail> {
      vi.stubEnv("FORMIC_URL", "https://formic.example");
      await assignApiAgent();
      await installRunner();
      const ticket = await seedTicket();
      await repository().updateTicket(ticket.id, { storyPoints });
      await runCoderAgent(PROJECT, ticket.id);
      return ticket;
    }

    /** The time limit the nth dispatched job was handed, if any. */
    function limitOf(nth: number): number | undefined {
      const payload = JSON.parse(MockVcsClient.runner().dispatches[nth]!.inputs.prompt!) as {
        limits: { maxDurationMs?: number };
      };
      return payload.limits.maxDurationMs;
    }

    it("gives a 3-point ticket 30 minutes by default", async () => {
      await ownProject({ mode: "PER_STORY_POINT" });
      await startRun(3);
      expect(limitOf(0)).toBe(30 * 60_000);
    });

    it("gives every ticket the flat minutes", async () => {
      await ownProject({ mode: "FLAT_MINUTES", flatMinutes: 30 });
      await startRun(1);
      expect(limitOf(0)).toBe(30 * 60_000);
    });

    it("gives a ticket its size's minutes per point", async () => {
      await ownProject({ mode: "PER_POINT", perPointMinutes: { 5: 40 } });
      await startRun(5);
      expect(limitOf(0)).toBe(40 * 60_000);
    });

    it("holds a run with no budget to the job's 55 usable minutes", async () => {
      await ownProject({ mode: "OFF" });
      await startRun(3);
      expect(limitOf(0)).toBe(55 * 60_000);
    });

    it("clamps an 8-point ticket to the job's ceiling and says so, with tokens and derived money", async () => {
      await ownProject({ mode: "PER_STORY_POINT" });
      await startRun(8);
      const { limits } = JSON.parse(MockVcsClient.runner().dispatches[0]!.inputs.prompt!) as {
        limits: Record<string, number>;
      };
      expect(limits).toMatchObject({ maxDurationMs: 55 * 60_000, budgetMs: 80 * 60_000, maxTokens: 512_000 });
      expect(limits.maxCents).toBe(1280);
      expect(MockVcsClient.runner().dispatches[0]!.inputs.timeout).toBe("60");
    });

    it("sizes the job's timeout to the budget", async () => {
      await ownProject({ mode: "FLAT_MINUTES", flatMinutes: 20 });
      await startRun(1);
      expect(MockVcsClient.runner().dispatches[0]!.inputs.timeout).toBe("25");
    });

    it("dispatches to an older workflow without a timeout, which keeps its own ceiling", async () => {
      await ownProject({ mode: "PER_STORY_POINT" });
      vi.stubEnv("FORMIC_URL", "https://formic.example");
      await assignApiAgent();
      const base = (await projectFor(PROJECT)).baseBranch;
      await new MockVcsClient("acme/widgets").commitFile(
        base,
        RUNNER_WORKFLOW_PATH,
        `# ${(await currentRunnerFiles()).version}\njobs:\n  agent:\n    timeout-minutes: 180\n`,
        "install",
      );
      const ticket = await seedTicket();
      await repository().updateTicket(ticket.id, { storyPoints: 3 });
      await runCoderAgent(PROJECT, ticket.id);
      expect(MockVcsClient.runner().dispatches[0]!.inputs).not.toHaveProperty("timeout");
    });

    it("keeps a run's budget when the setting changes afterwards", async () => {
      const userId = await ownProject({ mode: "PER_STORY_POINT" });
      const ticket = await startRun(3);

      await updateRunTimeBudgetSettings(userId, { mode: "FLAT_MINUTES", flatMinutes: 7 });
      await runCoderAgent(PROJECT, ticket.id);

      expect(limitOf(0)).toBe(30 * 60_000);
      expect(limitOf(1)).toBe(7 * 60_000);
    });
  });

  it("leaves a repository on an older workflow running in-process", async () => {
    const base = (await projectFor(PROJECT)).baseBranch;
    await assignApiAgent();
    await new MockVcsClient("acme/widgets").commitFile(
      base,
      RUNNER_WORKFLOW_PATH,
      "# formic-runner: 000000000000\n",
      "an older install",
    );
    const ticket = await seedTicket();
    // The in-process path calls the provider; this is only about it being the
    // path taken, so the call itself is made to fail at once.
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));

    await runCoderAgent(PROJECT, ticket.id);

    expect(MockVcsClient.runner().dispatches).toHaveLength(0);
    expect(MockVcsClient.runner().secrets.size).toBe(0);
    expect((await repository().ticketDetail(ticket.id))!.runnerJob).toBeNull();
  });

  it("dispatches a loop run out of the repository's own entry, with no public address", async () => {
    // The entry travels with the workflow, so the job runs it out of its own
    // checkout and a loop run needs no address of the board's own — a laptop
    // included (docs/local.md). The fixture stands in for a built entry;
    // `installRunner` installs what this board would.
    setLoopBundleDir("src/test/loop-entry-bundle");
    await assignApiAgent();
    await installRunner();
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const [dispatch] = MockVcsClient.runner().dispatches;
    expect(dispatch).toBeTruthy();
    // Nothing to fetch: the job has the entry.
    expect(dispatch!.inputs).not.toHaveProperty("bundle");
    expect((await repository().ticketDetail(ticket.id))!.runnerJob).toBe(dispatch!.inputs.job);
  });

  it("refuses a loop run when there is no entry to install and no address to serve one", async () => {
    // A board that was never built with an entry has nothing to put in a
    // repository, and with no public address it has nothing to hand a job
    // either, so there is nothing to run. Said here, rather than as a job that
    // fails a minute later.
    setLoopBundleDir("src/test");
    vi.stubEnv("FORMIC_URL", "");
    await assignApiAgent();
    const ticket = await seedTicket();
    const agent = (await loopAgentFor(PROJECT, "in_progress"))!;
    const run = startRun(PROJECT, "coder", {
      ticketId: ticket.id,
      model: agent.model,
      provider: agent.info.id,
    });

    await startJobRun({
      projectId: PROJECT,
      ticket,
      mode: "loop",
      agent,
      from: "main",
      prompt: "{}",
      run,
      stalledIn: "in_progress",
    });

    expect(MockVcsClient.runner().dispatches).toHaveLength(0);
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.blockedReason).toContain("no Formic loop entry to run");
    expect(after.blockedReason).toContain("no public address");
  });

  it("is not the agent a CLI column runs, and not one without a key", async () => {
    await assignClaudeCode();
    expect(await loopAgentFor(PROJECT, "in_progress")).toBeNull();

    const preset = await savePreset({
      name: "keyless",
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      prompt: "",
      apiKey: null,
    });
    await repository().setColumnAgent(PROJECT, "in_progress", preset.id);
    expect(await loopAgentFor(PROJECT, "in_progress")).toBeNull();
  });
});


describe("taking a loop run's work", () => {
  it("records what it used, from the trailer its summary carries", async () => {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    await runCoderAgent(PROJECT, ticket.id);
    const job = MockVcsClient.runner().dispatches[0]!.inputs.job!;

    MockVcsClient.stage(
      `${STAGING_PREFIX}${job}`,
      ["src/lib/feature/thing.ts"],
      `T-1: Add the thing\n\nIt adds the thing.\n\n${USAGE_TRAILER} ${JSON.stringify({
        model: "deepseek-chat",
        tokensIn: 1_200,
        tokensOut: 400,
        costCents: 7,
      })}`,
    );

    await completeCliRun(PROJECT, { job, mode: "loop", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.summary).toBe("Add the thing");
    expect(after.prNumber).toBeGreaterThan(0);
    // What it used is money, and it is counted on the card. (Tokens are on
    // the run, not the card: see TicketUpdate and the repository.)
    const card = (await repository().boardCards(PROJECT)).find((c) => c.id === ticket.id)!;
    expect(card.costCents).toBe(7);
  });

  it("closes a ticket a loop run reports as already done", async () => {
    await assignClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    await runCoderAgent(PROJECT, ticket.id);
    const job = MockVcsClient.runner().dispatches[0]!.inputs.job!;

    MockVcsClient.stage(
      `${STAGING_PREFIX}${job}`,
      [],
      `T-1: Nothing to change\n\nIt already does it, criterion by criterion.\n\n${ALREADY_DONE_TRAILER}`,
    );

    await completeCliRun(PROJECT, { job, mode: "loop", conclusion: "success", url: null });

    // Nothing to merge and nothing to review: it goes to Done like a merge,
    // with what the run found as its summary.
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("merged");
    expect(after.stalledIn).toBeNull();
    expect(after.summary).toBe("Already done: Nothing to change");
  });
});

describe("what a run reported it used", () => {
  it("reads the usage trailer out of a summary", () => {
    const messages = [
      `T-1: Add the thing\n\nIt adds the thing.\n\n${USAGE_TRAILER} {"model":"deepseek-chat","tokensIn":120,"tokensOut":40,"costCents":3}`,
    ];
    expect(usageOf(messages)).toEqual({
      model: "deepseek-chat",
      tokensIn: 120,
      tokensOut: 40,
      costCents: 3,
    });
  });

  it("says nothing for a run that reported nothing, or reported nonsense", () => {
    expect(usageOf(["T-1: Add the thing\n\nIt adds the thing."])).toBeNull();
    expect(usageOf([`${USAGE_TRAILER} {oops}`])).toBeNull();
    expect(usageOf([`${USAGE_TRAILER} {"model":"x"}`])).toBeNull();
    expect(usageOf([`${USAGE_TRAILER} {"model":"x","tokensIn":-1,"tokensOut":0,"costCents":0}`])).toBeNull();
  });
});

describe("the minutes a job is given", () => {
  it("is the budget plus headroom, never past the workflow's ceiling", () => {
    expect(jobTimeoutMinutes(30, 60)).toBe(35);
    expect(jobTimeoutMinutes(55, 60)).toBe(60);
    expect(jobTimeoutMinutes(80, 60)).toBe(60);
    expect(jobTimeoutMinutes(200, 180)).toBe(180);
  });

  it("is the whole ceiling when there is no budget", () => {
    expect(jobTimeoutMinutes(null, 60)).toBe(60);
  });
});
