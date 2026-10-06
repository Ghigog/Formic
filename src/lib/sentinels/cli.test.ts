import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { savePreset } from "@/lib/agents/presets";
import { resetAgents } from "@/lib/agents/registry";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { collectCliRuns, completeCliRun } from "@/lib/runner/runner";
import { ANSWER_PATH, RUNNER_WORKFLOW_PATH, runTitle } from "@/lib/runner/workflow";
import { currentRunnerFiles } from "@/lib/runner/bundle";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, STAGING_PREFIX, resetVcs, setVcs } from "@/lib/vcs";
import { parseCliReport } from "./cli";
import { SENTINELS } from "./roster";
import { summonSentinel, sentinelsFor } from "./service";

/** A sentinel audited by a CLI agent, in a GitHub Actions job. */

const PROJECT = "project_default";
const first = SENTINELS.find((s) => s.unlockLevel === 1)!;

const REPORT = {
  stars: 4,
  quote: "Tidy.",
  summary: "Solid. One gap.",
  likes: [{ text: "Clear modules.", ref: "src/index.ts" }],
  dislikes: [],
  wrong: [],
  missing: [{ text: "No tests for the parser.", ref: null }],
  files: ["src/index.ts"],
};

async function setUp() {
  const preset = await savePreset({ name: "claude-code", provider: "claude-code", model: "", prompt: "", apiKey: "tok" });
  await repository().setAssistantAgent(PROJECT, preset.id);
  const base = (await projectFor(PROJECT)).baseBranch;
  const client = new MockVcsClient("acme/widgets");
  await client.commitFile(base, RUNNER_WORKFLOW_PATH, (await currentRunnerFiles()).workflow, "install");
  return client;
}

/** Summons and waits for the job to be started. */
async function summon() {
  expect(await summonSentinel(PROJECT, first.id)).toEqual({ ok: true });
  await vi.waitFor(() => expect(MockVcsClient.runner().dispatches.length).toBeGreaterThan(0));
  return MockVcsClient.runner().dispatches.at(-1)!.inputs;
}

const audits = async () => repository().auditsFor(PROJECT);

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
  vi.unstubAllEnvs();
  resetEnvCache();
  resetVcs();
});

describe("a sentinel on a CLI agent", () => {
  it("audits in GitHub Actions and saves the report it sends back", async () => {
    const client = await setUp();
    const dispatch = await summon();

    expect(dispatch).toMatchObject({ mode: "ask", cli: "claude" });
    expect(dispatch.prompt).toContain(first.persona.slice(0, 30));
    expect(dispatch.prompt).toContain("Your final message is your report");
    expect((await sentinelsFor(PROJECT))[first.id]!.running).not.toBeNull();

    await client.commitFile(`${STAGING_PREFIX}${dispatch.job}`, ANSWER_PATH, JSON.stringify(REPORT), "answer");
    await completeCliRun(PROJECT, { job: dispatch.job!, mode: "ask", conclusion: "success", url: null });

    const state = (await sentinelsFor(PROJECT))[first.id]!;
    expect(state).toMatchObject({ stars: 4, quote: "Tidy.", running: null, error: null, files: ["src/index.ts"] });
    expect(state.report?.missing).toHaveLength(1);
  });

  it("collects the report when the webhook never arrives", async () => {
    const client = await setUp();
    const dispatch = await summon();
    await client.commitFile(`${STAGING_PREFIX}${dispatch.job}`, ANSWER_PATH, JSON.stringify(REPORT), "answer");
    MockVcsClient.runner().runs.set(runTitle("ask", "sentinel", dispatch.job!), {
      status: "completed",
      conclusion: "success",
      url: "https://github.com/acme/widgets/actions/runs/9",
    });
    await collectCliRuns(PROJECT);
    expect((await sentinelsFor(PROJECT))[first.id]).toMatchObject({ stars: 4, running: null });
  });

  it("asks once more when the report is not JSON, then fails with the reason", async () => {
    const client = await setUp();
    const dispatch = await summon();
    await client.commitFile(`${STAGING_PREFIX}${dispatch.job}`, ANSWER_PATH, "Looks fine to me.", "answer");
    await completeCliRun(PROJECT, { job: dispatch.job!, mode: "ask", conclusion: "success", url: null });

    expect((await sentinelsFor(PROJECT))[first.id]!.running).not.toBeNull();
    const retry = MockVcsClient.runner().dispatches.at(-1)!.inputs;
    expect(retry.job).not.toBe(dispatch.job);
    expect(retry.prompt).toContain("Formic could not use it");

    await client.commitFile(`${STAGING_PREFIX}${retry.job}`, ANSWER_PATH, "Still prose.", "answer");
    await completeCliRun(PROJECT, { job: retry.job!, mode: "ask", conclusion: "success", url: null });
    const state = (await sentinelsFor(PROJECT))[first.id]!;
    expect(state.running).toBeNull();
    expect(state.error).toContain("not the JSON object");
  });

  it("fails the audit when the job fails, and ignores a result nobody waits for", async () => {
    const client = await setUp();
    const dispatch = await summon();
    await completeCliRun(PROJECT, { job: dispatch.job!, mode: "ask", conclusion: "cancelled", url: null });
    expect((await sentinelsFor(PROJECT))[first.id]!.error).toContain("cancelled");

    // The audit is over: a late report for the same job changes nothing.
    await client.commitFile(`${STAGING_PREFIX}${dispatch.job}`, ANSWER_PATH, JSON.stringify(REPORT), "answer");
    await completeCliRun(PROJECT, { job: dispatch.job!, mode: "ask", conclusion: "success", url: null });
    expect((await sentinelsFor(PROJECT))[first.id]).toMatchObject({ stars: null });
    expect((await audits()).filter((a) => a.status === "done")).toHaveLength(0);
  });
});

describe("parseCliReport", () => {
  it("reads a report and clamps its stars", () => {
    const r = parseCliReport(JSON.stringify({ ...REPORT, stars: 9 }));
    expect(r).toMatchObject({ ok: true, stars: 5 });
  });

  it("says why it could not", () => {
    expect(parseCliReport(null)).toMatchObject({ ok: false });
    expect(parseCliReport("prose")).toMatchObject({ ok: false });
    expect(parseCliReport('{"stars": 3}')).toMatchObject({ ok: false });
  });
});
