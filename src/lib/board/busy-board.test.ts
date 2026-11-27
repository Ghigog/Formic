import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCoderAgent } from "@/lib/coder/pipeline";
import { setCheckoutFactory } from "@/lib/coder/checkout";
import { markMergedExternally, resetPullRequestSweep, reviewPullRequest } from "@/lib/review/pipeline";
import { resetMergeLanes } from "@/lib/review/lane";
import { settleLaunched, startRun } from "@/lib/agents/pipeline";
import { savePreset } from "@/lib/agents/presets";
import { createTodoItem, redraftTicket } from "@/lib/board/service";
import { startQueued } from "@/lib/board/queue";
import { resetAgents, setAgents } from "@/lib/agents/registry";
import { MockArchitectAgent, MockProductAgent, MockShowcaseAgent } from "@/lib/agents/mock";
import type { AgentContext, AgentOutcome, CodeChange, CoderAgent, CoderTask, ReviewTask, ReviewVerdict, ReviewerAgent } from "@/lib/agents/ports";
import { MemoryWorkspace, scopedWorkspace, type Workspace } from "@/lib/sandbox/workspace";
import { repository } from "@/lib/db";
import { scoreOf } from "@/lib/colony/game";
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

/** Holds every ticket it is given until `release`, so the colony stays full while the test looks. */
class GatedCoder implements CoderAgent {
  started: string[] = [];
  release!: () => void;
  private gate = new Promise<void>((resolve) => (this.release = resolve));
  async implement(_ctx: AgentContext, input: { task: CoderTask; workspace: Workspace }): Promise<AgentOutcome<CodeChange>> {
    this.started.push(input.task.key);
    await this.gate;
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

  it("keeps a review fix that needs a held file off the person: it waits, is not counted, and lands once the file is free", async () => {
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "r", position: 1 });
    const base = { epicId: epic.id, description: "d", acceptanceCriteria: ["c"], size: "M" as const, dependsOnKeys: [] };
    const [fixing, holder] = await repo.createTickets([
      { ...base, key: "T-1", title: "Fixing", fileScope: ["src"], position: 1 },
      { ...base, key: "T-2", title: "Holder", fileScope: ["tests/test_seat.gd.uid"], position: 2 },
    ]);
    await repo.updateTicket(holder!.id, { status: "running" });
    const pull = await vcs.openPullRequest({ headBranch: "t-1", baseBranch: "main", title: "T-1", body: "" });
    MockVcsClient.setChecks(pull.number, "failure");
    await repo.updateTicket(fixing!.id, { status: "review", stage: 6, prNumber: pull.number, branchName: "t-1", attempts: 0 });

    const commands: string[] = [];
    setCheckoutFactory(async (request) => {
      const raw: Workspace = Object.create(new MemoryWorkspace(), {
        changedFiles: { value: async () => ["tests/test_seat.gd", "tests/test_seat.gd.uid"] },
        exec: { value: async (cmd: string) => (commands.push(cmd), { exitCode: 0, stdout: "abc123\n", stderr: "" }) },
      });
      return { workspace: scopedWorkspace(raw, request.ticket.fileScope), raw, sandboxId: "sbx", async dispose() {} };
    });
    setAgents({
      reviewer: {
        review: async () => ({ ok: true, value: { summary: "fix", detail: "", verifiedWith: null, sendBack: null, followUps: [] }, usage: NO_USAGE }),
      },
    } as never);
    const pushed = () => commands.some((c) => c.includes("git push"));

    await reviewPullRequest(PROJECT, pull.number, (await vcs.pullRequest(pull.number)).headSha);
    const waiting = (await repo.ticketDetail(fixing!.id))!;
    expect(waiting.status).toBe("queued");
    expect(waiting.attempts).toBe(0);
    expect(pushed()).toBe(false);

    MockVcsClient.setChecks(pull.number, "success");
    await repo.updateTicket(holder!.id, { status: "review" });
    await startQueued(PROJECT);
    await until(async () => pushed(), "the fix pushed");

    const proposals = (await repo.assistantMessages(PROJECT)).messages.flatMap((m) => m.proposals);
    expect(proposals).toEqual([]);
    const cards = await repo.boardCards(PROJECT);
    expect(cards.filter((c) => c.kind === "ticket" && c.status === "blocked").map((c) => c.key)).toEqual([]);
    expect((await repo.ticketDetail(fixing!.id))!.attempts).toBeLessThanOrEqual(1);
    const chat = (await repo.cardChatMessages(fixing!.id)).messages.map((m) => m.content).join("\n");
    expect(chat).not.toMatch(/Out of reviews|say yes|allow them/i);
  });

  it("drafts requests added during a usage limit once it lifts, and tells the person nothing", async () => {
    setAgents({
      product: new MockProductAgent(),
      architect: new MockArchitectAgent(),
      coder: new OverlappingCoder(),
      reviewer: new ApprovingReviewer(),
      showcase: new MockShowcaseAgent(),
    });
    const repo = repository();
    const architect = await savePreset({ name: "architect", provider: "claude-code", model: "", prompt: "x", ownerId: "u1", secretName: "ARCH" });
    await repo.setColumnAgent(PROJECT, "todo", architect.id);
    await repo.setPresetLimit(architect.id, { until: new Date(Date.now() + 3_600_000), note: "Claude Code hit its usage limit." });

    const added = [];
    for (const text of ["A bug in the fridge", "Add a practice mode", "Sink holds ten items"]) {
      added.push(await createTodoItem(PROJECT, text));
    }

    // The limit lifts; the idle sweep redrafts each placeholder.
    await repo.setPresetLimit(architect.id, null);
    for (const card of added) expect(await redraftTicket(PROJECT, card.id)).toBe(true);
    await settleLaunched(15_000);

    const chat = (await repo.assistantMessages(PROJECT)).messages.map((m) => m.content).join("\n");
    expect(chat).not.toMatch(/needs you|Waiting for you|Drafting the ticket/);
    expect((await repo.assistantMessages(PROJECT)).messages.flatMap((m) => m.proposals)).toEqual([]);
  });

  it("keeps a burst of activated tickets from starting at once on a Lv 3 Automatic board, and still gives an urgent bug its slot", async () => {
    const coder = new GatedCoder();
    setAgents({
      product: new MockProductAgent(),
      architect: new MockArchitectAgent(),
      coder,
      reviewer: new ApprovingReviewer(),
      showcase: new MockShowcaseAgent(),
    });
    const repo = repository();
    expect((await repo.projectById(PROJECT))!.colonyMode).toBe("auto");

    // Lv 3: two merged tickets of 55 points are 110 XP.
    const done = await repo.createEpic({ projectId: PROJECT, title: "Done", rawRequest: "r", position: 1 });
    const merged = await repo.createTickets(
      [1, 2].map((n) => ({
        epicId: done.id,
        key: `D-${n}`,
        title: "Done",
        description: "d",
        acceptanceCriteria: ["c"],
        fileScope: [`docs/done${n}`],
        size: "M" as const,
        storyPoints: 55,
        position: n,
        dependsOnKeys: [],
      })),
    );
    for (const t of merged) await repo.updateTicket(t.id, { status: "merged" });
    expect(scoreOf(await repo.boardCards(PROJECT)).level).toBe(3);

    // A burst of ten routine tickets, each on its own files, activated together.
    const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "r", position: 2 });
    const routine = await repo.createTickets(
      Array.from({ length: 10 }, (_, i) => ({
        epicId: epic.id,
        key: `R-${i + 1}`,
        title: `Routine ${i + 1}`,
        description: "d",
        acceptanceCriteria: ["c"],
        fileScope: [`src/lib/routine${i + 1}`],
        size: "M" as const,
        position: i + 1,
        dependsOnKeys: [],
      })),
    );
    for (const t of routine) await repo.updateTicket(t.id, { status: "queued" });
    const ticketsNow = async () => (await repo.boardCards(PROJECT)).filter((c) => c.kind === "ticket" && c.epicId === epic.id);
    const count = async (status: string) => (await ticketsNow()).filter((c) => c.status === status).length;

    await startQueued(PROJECT);
    // 4 slots, 1 kept for urgent work: 3 start, the rest wait with the reason.
    expect(await count("running")).toBe(3);
    const waiting = (await ticketsNow()).filter((c) => c.status === "queued");
    expect(waiting).toHaveLength(7);
    for (const c of waiting) {
      expect(c.blockedReason).toBe("The colony is full: 3 of 4 slots in use, 1 kept in reserve for urgent work.");
    }

    // An urgent bug takes the reserved slot while routine work fills the rest.
    const bug = (await repo.createTickets([
      { epicId: epic.id, key: "B-1", title: "Bug", description: "d", acceptanceCriteria: ["c"], fileScope: ["src/lib/bug"], size: "S", position: 20, dependsOnKeys: [], workType: "bug" },
    ]))[0]!;
    await repo.updateTicket(bug.id, { status: "queued" });
    await startQueued(PROJECT);
    expect((await repo.cardById(bug.id))!.status).toBe("running");
    expect(await count("running")).toBe(4);

    // A ticket back from review with its pull request open takes the slot as well.
    await until(async () => coder.started.includes("B-1"), "the bug's agent to start");
    const fix = (await ticketsNow()).find((c) => c.status === "queued")!;
    await repo.updateTicket(bug.id, { status: "review" });
    await repo.updateTicket(fix.id, { prNumber: 99, branchName: "fix" });
    await startQueued(PROJECT);
    expect((await repo.cardById(fix.id))!.blockedReason).toBeNull();
    expect((await repo.cardById(fix.id))!.status).toBe("running");

    // As slots free, the rest start one by one.
    await until(async () => coder.started.length === 5, "the agents to start");
    for (const c of (await ticketsNow()).filter((c) => c.status === "running")) await repo.updateTicket(c.id, { status: "review" });
    await startQueued(PROJECT);
    expect(await count("running")).toBe(3);
    expect(await count("queued")).toBe(3);

    // Nothing landed on the person.
    expect((await ticketsNow()).filter((c) => c.status === "blocked" || c.needsHuman)).toEqual([]);
    expect((await repo.assistantMessages(PROJECT)).messages.flatMap((m) => m.proposals)).toEqual([]);
    coder.release();
  });
});
