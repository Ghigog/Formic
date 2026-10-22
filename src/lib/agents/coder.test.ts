import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCodingLoop, compareOnClaude, compareOnOpenAi } = vi.hoisted(() => ({
  runCodingLoop: vi.fn(),
  compareOnClaude: vi.fn(),
  compareOnOpenAi: vi.fn(),
}));

vi.mock("./coding-loop", () => ({ runCodingLoop }));
vi.mock("./anthropic", () => ({ compareScoutsOnClaude: compareOnClaude }));
vi.mock("./openai-agents", () => ({ compareScoutsOnOpenAi: compareOnOpenAi }));

import { LoopCoderAgent, LoopReviewerAgent, coderPrompt, failuresBrief, reviewBrief, taskBrief } from "./coder";
import type { AgentContext, CoderTask, ReviewTask } from "./ports";
import { MemoryWorkspace } from "@/lib/sandbox/workspace";

const TASK: CoderTask = {
  ticketId: "t1",
  key: "T-1",
  title: "Add a thing",
  description: "Do the thing.",
  acceptanceCriteria: ["It works", "It is tested"],
  fileScope: ["src/a", "src/b"],
};

const CTX = { runId: "r", projectId: "p", emit: () => undefined, signal: new AbortController().signal } as AgentContext;

const reviewInput = (over: Partial<ReviewTask> = {}): Omit<ReviewTask, "workspace"> => ({
  task: TASK,
  baseBranch: "main",
  changedFiles: ["src/a/x.ts"],
  checks: [],
  ciRunning: false,
  attempt: 2,
  maxAttempts: 3,
  ...over,
} as Omit<ReviewTask, "workspace">);

beforeEach(() => vi.clearAllMocks());

describe("taskBrief", () => {
  it("lists the ticket, its criteria, scope and estimate", () => {
    const brief = taskBrief({ ...TASK, storyPoints: 5 });

    expect(brief).toContain("Ticket T-1: Add a thing");
    expect(brief).toContain("- It is tested");
    expect(brief).toContain("src/a, src/b");
    expect(brief).toContain("Estimate: 5 story points.");
    expect(brief).not.toContain("Notes on this ticket");
  });

  it("puts a chat instruction first and appends notes", () => {
    const brief = taskBrief({ ...TASK, instruction: "Only fix the test", notes: ["be brief"], sharedNotes: ["other agent said x"] });

    expect(brief.indexOf("Only fix the test")).toBeLessThan(brief.indexOf("Ticket T-1"));
    expect(brief).toContain("- be brief");
    expect(brief).toContain("- other agent said x");
  });
});

describe("coderPrompt", () => {
  it("asks for the work and says how to report it done already", () => {
    const prompt = coderPrompt(TASK);

    expect(prompt).toContain("Implement it.");
    expect(prompt).toContain("already_done");
  });
});

describe("failuresBrief", () => {
  it("names each failing check with its annotations", () => {
    const text = failuresBrief([
      { name: "lint", summary: "2 errors", annotations: [{ path: "a.ts", line: 3, message: "bad" }, { path: "b.ts", message: "worse" }] },
      { name: "test", summary: "", annotations: [] },
    ] as never);

    expect(text).toContain('Check "lint" failed.');
    expect(text).toContain("a.ts:3 — bad");
    expect(text).toContain("b.ts — worse");
    expect(text).toContain('Check "test" failed.');
  });
});

describe("reviewBrief", () => {
  it("says CI is green when nothing is red or running", () => {
    expect(reviewBrief(reviewInput())).toContain("CI is green on this head");
    expect(reviewBrief(reviewInput())).toContain("review 2 of 3");
  });

  it("says CI is running", () => {
    expect(reviewBrief(reviewInput({ ciRunning: true }))).toContain("CI is still running");
  });

  it("lists failing checks", () => {
    const brief = reviewBrief(reviewInput({ checks: [{ name: "lint", summary: "boom", annotations: [] }] as never }));

    expect(brief).toContain("CI is red");
    expect(brief).toContain('Check "lint" failed.');
  });

  it("asks only for conflict resolution when the branch conflicts, with history", () => {
    const brief = reviewBrief(
      reviewInput({
        conflicts: ["src/a/x.ts"],
        conflictHistory: { base: ["Renamed x\nbecause"], branch: ["Added y"] },
      }),
    );

    expect(brief).toContain("conflicts with main");
    expect(brief).toContain("- src/a/x.ts");
    expect(brief).toContain("- Renamed x\n  because");
    expect(brief).toContain("Why this pull request changed them");
  });

  it("copes with no changed files and conflicts without a file list", () => {
    const brief = reviewBrief(reviewInput({ changedFiles: [], conflicts: [] }));

    expect(brief).toContain("(none listed)");
    expect(brief).toContain("conflict markers.");
  });
});

describe("LoopCoderAgent", () => {
  it("runs the loop as coder and drops the send-back from its change", async () => {
    runCodingLoop.mockResolvedValue({
      ok: true,
      value: { summary: "s", detail: "d", verifiedWith: null, sendBack: "no" },
      usage: {},
    });

    const out = await new LoopCoderAgent({ model: "m" }).implement(CTX, { task: TASK, workspace: new MemoryWorkspace() });

    expect(runCodingLoop.mock.calls[0]![0]).toMatchObject({ role: "coder", ticketId: "t1", model: "m" });
    expect(out.ok && out.value).toEqual({ summary: "s", detail: "d", verifiedWith: null });
  });

  it("passes a failure through", async () => {
    const failed = { ok: false, error: "x" };
    runCodingLoop.mockResolvedValue(failed);

    const out = await new LoopCoderAgent().implement(CTX, { task: TASK, workspace: new MemoryWorkspace() });

    expect(out).toBe(failed);
  });
});

describe("LoopReviewerAgent", () => {
  it("reviews through the loop as reviewer", async () => {
    runCodingLoop.mockResolvedValue({ ok: true });

    await new LoopReviewerAgent().review(CTX, { ...reviewInput(), workspace: new MemoryWorkspace() } as ReviewTask);

    expect(runCodingLoop.mock.calls[0]![0]).toMatchObject({ role: "reviewer" });
  });

  it("compares scouts on Claude by default", async () => {
    compareOnClaude.mockResolvedValue("claude");

    expect(await new LoopReviewerAgent().compare(CTX, { task: TASK, candidates: [] })).toBe("claude");
  });

  it("compares scouts on an OpenAI-compatible provider when configured", async () => {
    compareOnOpenAi.mockResolvedValue("openai");

    expect(await new LoopReviewerAgent({ provider: "openai" }).compare(CTX, { task: TASK, candidates: [] })).toBe("openai");
  });
});
