import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeCliRun, secretNameFor } from "./runner";
import {
  ANSWER_PATH,
  RUNNER_SETUP_BRANCH,
  RUNNER_WORKFLOW_NAME,
  RUNNER_WORKFLOW_PATH,
  parseRunTitle,
  runTitle,
  runnerWorkflow,
} from "./workflow";
import { runCoderAgent } from "@/lib/coder/pipeline";
import { cliAgentFor, savePreset } from "@/lib/agents/presets";
import { runArchitectAgent, runProductAgent } from "@/lib/agents/pipeline";
import type { ColumnId } from "@/lib/domain/status";
import { resetAgents } from "@/lib/agents/registry";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { resetMergeLanes } from "@/lib/review/lane";
import { interpret } from "@/lib/review/webhook";
import { resetEnvCache } from "@/lib/secrets/env";
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
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  return (await repo.ticketDetail(ticket!.id))!;
}

async function useClaudeCode(column: ColumnId = "in_progress") {
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
  await new MockVcsClient("acme/widgets").commitFile(
    base,
    RUNNER_WORKFLOW_PATH,
    runnerWorkflow(),
    "install",
  );
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
  resetEnvCache();
});

describe("CLI agent templates", () => {
  it("run in any column", async () => {
    const preset = await useClaudeCode();
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
    await useClaudeCode("backlog");
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

  it("keeps a stalled Epic stalled, with why, across a reload", async () => {
    await useClaudeCode("backlog");
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
    await useClaudeCode("todo");
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

  it("gives up after the last attempt instead of asking forever", async () => {
    await useClaudeCode("todo");
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
    await useClaudeCode("backlog");
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
});

describe("starting a CLI agent", () => {
  it("opens a setup pull request first, and waits for a person to merge it", async () => {
    await useClaudeCode();
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("Merge the setup pull request");
    const runner = MockVcsClient.runner();
    expect(runner.files.get(`${RUNNER_SETUP_BRANCH}:${RUNNER_WORKFLOW_PATH}`)).toContain(
      RUNNER_WORKFLOW_NAME,
    );
    expect(runner.dispatches).toHaveLength(0);
    expect(runner.secrets.size).toBe(0);
  });

  it("stores the plan token as the agent's own secret and dispatches the workflow", async () => {
    const preset = await useClaudeCode();
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
    expect(inputs).toMatchObject({ mode: "implement", ticket: "T-1", cli: "claude", from: base, secret });
    expect(inputs.prompt).toContain("Implement the ticket.");
    expect(inputs.prompt).toContain("src/lib/feature");
    expect(JSON.stringify(inputs)).not.toContain(TOKEN);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("running");
    expect(after.runnerJob).toBe(inputs.job);
  });

  it("keeps two accounts on the same CLI in separate secrets", async () => {
    const work = await useClaudeCode("in_progress");
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
    const preset = await useClaudeCode();
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
    const preset = await useClaudeCode();
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
    await useClaudeCode();
    await installRunner();
    const ticket = await seedTicket();
    await runCoderAgent(PROJECT, ticket.id);
    const job = MockVcsClient.runner().dispatches[0]!.inputs.job!;
    return { ticket, job, staging: `${STAGING_PREFIX}${job}` };
  }

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

  it("throws out work outside the file scope, and pushes nothing", async () => {
    const { ticket, job, staging } = await dispatched();
    MockVcsClient.stage(staging, ["src/lib/feature/a.ts", "package.json"], "T-1: stuff");

    await completeCliRun(PROJECT, { job, mode: "implement", conclusion: "success", url: null });

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("package.json");
    expect(after.prNumber).toBeNull();
    const branches = MockVcsClient.runner().branches;
    expect(branches.has(after.branchName!)).toBe(false);
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

describe("a CLI agent fixing red CI", () => {
  it("fast-forwards the pull request's branch with the fix", async () => {
    await useClaudeCode("in_review");
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
  });
});

describe("the runner workflow", () => {
  it("never splices inputs into a script", () => {
    const yaml = runnerWorkflow();
    for (const line of yaml.split("\n")) {
      if (!line.includes("${{ inputs.")) continue;
      // Allowed: env values, the checkout ref, the title and the concurrency key.
      expect(line).toMatch(/^\s+([A-Z_]+|ref|group):\s|^run-name:/);
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

  it("keeps only the answer from a planning run", () => {
    const yaml = runnerWorkflow();
    expect(yaml).toContain("product|architect|showcase|ask)");
    expect(yaml).toContain('git reset -q --hard "$FORMIC_START"');
    expect(yaml).toContain(`git add -f "${ANSWER_PATH}"`);
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
});
