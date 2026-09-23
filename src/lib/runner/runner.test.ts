import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeCliRun } from "./runner";
import {
  RUNNER_SETUP_BRANCH,
  RUNNER_WORKFLOW_NAME,
  RUNNER_WORKFLOW_PATH,
  parseRunTitle,
  runTitle,
  runnerWorkflow,
} from "./workflow";
import { runCoderAgent } from "@/lib/coder/pipeline";
import { agentFor, cliAgentFor, savePreset } from "@/lib/agents/presets";
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

async function useClaudeCode(column: "in_progress" | "in_review" = "in_progress") {
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
  it("run only in the coding columns", async () => {
    const preset = await useClaudeCode();
    await repository().setColumnAgent(PROJECT, "backlog", preset.id);

    expect(await cliAgentFor(PROJECT, "in_progress")).toMatchObject({
      credential: TOKEN,
      model: null,
      info: { cli: "claude", secretName: "FORMIC_CLAUDE_CODE_TOKEN" },
    });
    const outcome = await (await agentFor(PROJECT, "product")).draftPrd(
      {} as never,
      { epicId: "e", rawRequest: "x" },
    );
    expect(outcome).toMatchObject({ ok: false, blocked: true });
    expect(!outcome.ok && outcome.error).toContain("In Progress or In Review");
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

  it("stores the plan token as a secret and dispatches the workflow", async () => {
    await useClaudeCode();
    const base = await installRunner();
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const runner = MockVcsClient.runner();
    expect(runner.secrets.get("FORMIC_CLAUDE_CODE_TOKEN")).toBe(TOKEN);
    expect(runner.dispatches).toHaveLength(1);
    const { file, ref, inputs } = runner.dispatches[0]!;
    expect(file).toBe("formic-agent.yml");
    expect(ref).toBe(base);
    expect(inputs).toMatchObject({ mode: "implement", ticket: "T-1", cli: "claude", from: base });
    expect(inputs.prompt).toContain("Implement the ticket.");
    expect(inputs.prompt).toContain("src/lib/feature");
    expect(JSON.stringify(inputs)).not.toContain(TOKEN);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("running");
    expect(after.runnerJob).toBe(inputs.job);
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

  it("round-trips its title, which is how its result finds the ticket", () => {
    expect(parseRunTitle(runTitle("fix", "T-12", "abc--1234"))).toEqual({
      mode: "fix",
      ticketKey: "T-12",
      job: "abc--1234",
    });
  });

  it("reports back as a runner signal, not as CI", () => {
    const signals = interpret("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 7,
        name: RUNNER_WORKFLOW_NAME,
        display_title: runTitle("implement", "T-1", "tkt--abcd1234"),
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
