import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { savePreset } from "@/lib/agents/presets";
import { resetAgents } from "@/lib/agents/registry";
import { projectFor } from "@/lib/board/project";
import { scoreOf } from "@/lib/colony/game";
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
const first = SENTINELS[0]!;

const RUBRIC = {
  context: "A widget library.",
  rungs: [2, 3, 4, 5].map((stars) => ({ stars, checks: [{ id: `${stars}a`, text: `Bar ${stars}.`, how: "Read it." }] })),
};

const CALIBRATION = {
  context: "A widget library.",
  rungs: [2, 3, 4, 5].map((n) => ({ checks: [{ text: `Bar ${n}.`, how: "Read it." }] })),
  files: ["src/index.ts"],
};

const REPORT = {
  checks: [
    { id: "2a", evidence: "Seen.", met: true },
    { id: "3a", evidence: "Seen.", met: true },
    { id: "4a", evidence: "Seen.", met: true },
    { id: "5a", evidence: "Missing.", met: false },
  ],
  quote: "Tidy.",
  summary: "Solid. One gap.",
  likes: [{ text: "Clear modules.", ref: "src/index.ts" }],
  dislikes: [],
  wrong: [],
  missing: [{ text: "No tests for the parser.", ref: null }],
  files: ["src/index.ts"],
};

/** Merges enough work for the colony to reach the sentinel's level. */
async function earnLevel(level: number) {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Done", rawRequest: "Done", position: 9 });
  for (let i = 0; scoreOf(await repo.boardCards(PROJECT)).level < level; i++) {
    const [done] = await repo.createTickets([
      { epicId: epic.id, key: `D-${i}`, title: "d", description: "d", acceptanceCriteria: [], fileScope: [`src/d${i}`], size: "S", storyPoints: 13, position: i, dependsOnKeys: [] },
    ]);
    await repo.updateTicket(done!.id, { status: "merged" });
  }
}

async function setUp() {
  await earnLevel(first.unlockLevel);
  const preset = await savePreset({ name: "claude-code", provider: "claude-code", model: "", prompt: "", apiKey: "tok" });
  await repository().setAssistantAgent(PROJECT, preset.id);
  const base = (await projectFor(PROJECT)).baseBranch;
  const client = new MockVcsClient("acme/widgets");
  await client.commitFile(base, RUNNER_WORKFLOW_PATH, (await currentRunnerFiles()).workflow, "install");
  return client;
}

/** A rubric the sentinel calibrated earlier. */
async function calibrated() {
  const c = await repository().startAudit(PROJECT, first.id, "calibrate");
  await repository().finishAudit(c.id, { status: "done", rubric: RUBRIC, summary: RUBRIC.context });
}

/** Summons and waits for the job to be started. */
async function summon(kind: "audit" | "calibrate" = "audit") {
  if (kind === "audit") await calibrated();
  const before = MockVcsClient.runner().dispatches.length;
  expect(await summonSentinel(PROJECT, first.id, kind)).toEqual({ ok: true });
  await vi.waitFor(() => expect(MockVcsClient.runner().dispatches.length).toBeGreaterThan(before));
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
  it("refuses to audit before calibrating", async () => {
    await setUp();
    expect(await summonSentinel(PROJECT, first.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("calibrates in GitHub Actions and saves the rubric it sends back", async () => {
    const client = await setUp();
    const dispatch = await summon("calibrate");
    expect(dispatch.prompt).toContain("You are calibrating, not auditing");

    await client.commitFile(`${STAGING_PREFIX}${dispatch.job}`, ANSWER_PATH, JSON.stringify(CALIBRATION), "answer");
    await completeCliRun(PROJECT, { job: dispatch.job!, mode: "ask", conclusion: "success", url: null });

    const state = (await sentinelsFor(PROJECT))[first.id]!;
    expect(state).toMatchObject({ stars: null, running: null, error: null });
    expect(state.rubric?.rubric).toEqual(RUBRIC);
  });

  it("audits in GitHub Actions and saves the report it sends back", async () => {
    const client = await setUp();
    const dispatch = await summon();

    expect(dispatch).toMatchObject({ mode: "ask", cli: "claude" });
    expect(dispatch.prompt).toContain(first.persona.slice(0, 30));
    expect(dispatch.prompt).toContain("Your final message is your report");
    expect(dispatch.prompt).toContain("[4a] Bar 4.");
    expect((await sentinelsFor(PROJECT))[first.id]!.running).not.toBeNull();

    await client.commitFile(`${STAGING_PREFIX}${dispatch.job}`, ANSWER_PATH, JSON.stringify(REPORT), "answer");
    await completeCliRun(PROJECT, { job: dispatch.job!, mode: "ask", conclusion: "success", url: null });

    const state = (await sentinelsFor(PROJECT))[first.id]!;
    expect(state).toMatchObject({ stars: 4, quote: "Tidy.", running: null, error: null, files: ["src/index.ts"] });
    expect(state.report?.missing).toHaveLength(1);
    expect(state.scoredWith).toEqual(RUBRIC);
    expect(state.rubricChanged).toBe(false);
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
    expect((await audits()).filter((a) => a.kind === "audit" && a.status === "done")).toHaveLength(0);
  });
});

describe("parseCliReport", () => {
  const goal = { kind: "audit" as const, rubric: RUBRIC };

  it("works the stars out from the checks, ignoring any it was given", () => {
    const r = parseCliReport(JSON.stringify({ ...REPORT, stars: 5 }), goal);
    expect(r).toMatchObject({ ok: true, stars: 4 });
  });

  it("counts a check it left out as not met", () => {
    const r = parseCliReport(JSON.stringify({ ...REPORT, checks: REPORT.checks.filter((c) => c.id !== "3a") }), goal);
    expect(r).toMatchObject({ ok: true, stars: 2 });
    expect(r.ok && r.report?.checks?.find((c) => c.id === "3a")).toMatchObject({ met: false });
  });

  it("reads a calibration as a rubric", () => {
    expect(parseCliReport(JSON.stringify(CALIBRATION), { kind: "calibrate" })).toMatchObject({ ok: true, rubric: RUBRIC });
  });

  it("says why it could not", () => {
    expect(parseCliReport(null, goal)).toMatchObject({ ok: false });
    expect(parseCliReport("prose", goal)).toMatchObject({ ok: false });
    expect(parseCliReport('{"stars": 3}', goal)).toMatchObject({ ok: false });
    expect(parseCliReport(JSON.stringify({ context: "x", rungs: [] }), { kind: "calibrate" })).toMatchObject({ ok: false });
  });
});
