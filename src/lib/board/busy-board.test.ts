import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCoderAgent } from "@/lib/coder/pipeline";
import { setCheckoutFactory } from "@/lib/coder/checkout";
import { markMergedExternally, resetPullRequestSweep } from "@/lib/review/pipeline";
import { resetMergeLanes } from "@/lib/review/lane";
import { settleLaunched, startRun } from "@/lib/agents/pipeline";
import { savePreset } from "@/lib/agents/presets";
import { resetAgents, setAgents } from "@/lib/agents/registry";
import { MockArchitectAgent, MockProductAgent, MockShowcaseAgent } from "@/lib/agents/mock";
import type { AgentContext, AgentOutcome, CodeChange, CoderAgent, CoderTask, ReviewTask, ReviewVerdict, ReviewerAgent } from "@/lib/agents/ports";
import type { Workspace } from "@/lib/sandbox/workspace";
import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";

/**
 * A busy board, end to end: several tickets overlapping, a merge, and a
 * misread usage limit, all at once. Each of these is tested on its own
 * elsewhere; this is where they meet, because that is where the board
 * broke before (AGENTS.md, "The board decides what it can").
 *
 * The one rule held here: none of it lands on the person. No ticket stops
 * to ask, no proposal appears in the PM chat, and no mark outlives the
 * evidence against it.
 */

const PROJECT = "project_default";
const REPO = "acme/widgets";
const NO_USAGE = { model: "stub", tokensIn: 0, tokensOut: 0, costCents: 0 };

/** Writes inside its scope and in src/app, which another ticket is writing. */
class OverlappingCoder implements CoderAgent {
  tasks: CoderTask[] = [];
  async implement(_ctx: AgentContext, input: { task: CoderTask; workspace: Workspace }): Promise<AgentOutcome<CodeChange>> {
    this.tasks.push(input.task);
    await input.workspace.writeFile(`${input.task.fileScope.find((p) => p.startsWith("src/lib"))}/thing.ts`, "export const a = 1;\n");
    await input.workspace.writeFile("src/app/page.tsx", "export default null;\n");
    return { ok: true, value: { summary: "did the thing", detail: "details", verifiedWith: "npm test", handoff: [], followUps: [] }, usage: NO_USAGE };
  }
}

class ApprovingReviewer implements ReviewerAgent {
  async review(_ctx: AgentContext, _input: ReviewTask): Promise<AgentOutcome<ReviewVerdict>> {
    return { ok: true, value: { summary: "ok", detail: "", verifiedWith: null, sendBack: null, followUps: [] }, usage: NO_USAGE };
  }
}

async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

let vcs: MockVcsClient;

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetMergeLanes();
  resetAgents();
  resetVcs();
  resetPullRequestSweep();
  setCheckoutFactory(null);
  vcs = new MockVcsClient(REPO);
  setVcs(vcs);
});

afterEach(() => settleLaunched(15_000), 20_000);

describe("a busy board", () => {
  it("settles overlapping scope, a merge and a misread limit without asking the person anything", async () => {
    const coder = new OverlappingCoder();
    setAgents({
      product: new MockProductAgent(),
      architect: new MockArchitectAgent(),
      coder,
      reviewer: new ApprovingReviewer(),
      showcase: new MockShowcaseAgent(),
    });
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "r", position: 1 });
    const base = { epicId: epic.id, description: "d", acceptanceCriteria: ["c"], size: "M" as const, dependsOnKeys: [] };
    const [feature, shell, red, merging] = await repo.createTickets([
      { ...base, key: "T-1", title: "Feature", fileScope: ["src/lib/feature"], position: 1 },
      { ...base, key: "T-2", title: "Shell", fileScope: ["src/app"], position: 2 },
      { ...base, key: "T-3", title: "Red", fileScope: ["src/lib/red"], position: 3 },
      { ...base, key: "T-4", title: "Merging", fileScope: ["src/lib/merging"], position: 4 },
    ]);

    // T-2 is running in src/app, which T-1's work turns out to need.
    await repo.updateTicket(shell!.id, { status: "running" });

    // T-3 is blocked on red CI, its branch behind main.
    const redPull = await vcs.openPullRequest({ headBranch: "t-3", baseBranch: "main", title: "T-3", body: "" });
    await repo.updateTicket(red!.id, { status: "blocked", stalledIn: "in_review", stage: 6, prNumber: redPull.number, branchName: "t-3", blockedReason: "CI is red." });
    MockVcsClient.behindBase(redPull.number);

    // T-4 is in review and about to merge.
    const mergingPull = await vcs.openPullRequest({ headBranch: "t-4", baseBranch: "main", title: "T-4", body: "" });
    await repo.updateTicket(merging!.id, { status: "review", stage: 6, prNumber: mergingPull.number, branchName: "t-4" });

    // An agent was marked out of usage off a misread log.
    const worker = await savePreset({ name: "worker", provider: "claude-code", model: "", prompt: "x", ownerId: "u1", secretName: "SHARED" });
    const sibling = await savePreset({ name: "sibling", provider: "claude-code", model: "", prompt: "x", ownerId: "u1", secretName: "SHARED" });
    for (const p of [worker, sibling]) {
      await repo.setPresetLimit(p.id, { until: new Date(Date.now() + 5 * 3_600_000), note: "Claude Code hit its usage limit." });
    }

    // T-1 runs and needs T-2's files.
    await repo.updateTicket(feature!.id, { status: "running" });
    await runCoderAgent(PROJECT, feature!.id);
    const queued = (await repo.ticketDetail(feature!.id))!;
    expect(queued.status).toBe("queued");
    expect(queued.fileScope).toContain("src/app/page.tsx");
    // The mock checkout pushes nothing: stand the kept work on its branch.
    MockVcsClient.stage(queued.branchName!, ["src/lib/feature/thing.ts", "src/app/page.tsx"], "T-1: did the thing");

    // T-4 merges: T-3 takes main in on its own.
    await markMergedExternally(PROJECT, mergingPull.number);
    await until(async () => (await repo.ticketDetail(red!.id))!.status === "review", "T-3 brought up to date");

    // The account is seen working: the mark lifts from both agents on it.
    const run = startRun(PROJECT, "coder", { presetId: worker.id });
    await run.finish({ ok: true, value: null, usage: { model: "m", tokensIn: 10, tokensOut: 10, costCents: 0 } });
    for (const p of [worker, sibling]) {
      expect((await repo.presetForRun(p.id))!.preset.limitedUntil).toBeNull();
    }

    // T-2 stops: T-1 carries on from its kept work, on its own.
    await repo.updateTicket(shell!.id, { status: "review" });
    await publish(PROJECT, { type: "card.status", cardId: shell!.id, kind: "ticket", status: "review", stalledIn: null, stage: 0, blockedReason: null });
    await until(async () => !!(await repo.ticketDetail(feature!.id))?.prNumber, "T-1's pull request");
    expect(coder.tasks).toHaveLength(1);

    // Nothing landed on the person.
    const proposals = (await repo.assistantMessages(PROJECT)).messages.flatMap((m) => m.proposals);
    expect(proposals).toEqual([]);
    const cards = await repo.boardCards(PROJECT);
    expect(cards.filter((c) => c.kind === "ticket" && c.status === "blocked").map((c) => c.key)).toEqual([]);
    for (const card of cards) {
      const chat = (await repo.cardChatMessages(card.id)).messages;
      expect(chat.map((m) => m.content).join("\n")).not.toMatch(/say yes|allow them/i);
    }
  });
});
