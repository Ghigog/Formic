import { beforeEach, describe, expect, it } from "vitest";
import { setCheckoutFactory } from "./checkout";
import { MemoryWorkspace, scopedWorkspace, type Workspace } from "@/lib/sandbox/workspace";
import { resetMergeLanes } from "@/lib/review/lane";
import { resetPullRequestSweep } from "@/lib/review/pipeline";
import { repository } from "@/lib/db";
import { resetAgents, setAgents } from "@/lib/agents/registry";
import type {
  AgentContext,
  AgentOutcome,
  CodeChange,
  CoderAgent,
  CoderTask,
  ReviewTask,
  ReviewVerdict,
  ReviewerAgent,
} from "@/lib/agents/ports";
import type { ScoutCandidate, ScoutVerdict } from "@/lib/agents/judge";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";
import { MockArchitectAgent, MockProductAgent, MockShowcaseAgent } from "@/lib/agents/mock";
import { autoScout, sendScouts, swapScout, SCOUT_APPROACHES } from "./scouts";
import { runCoderAgent } from "./pipeline";
import { scoreOf } from "@/lib/colony/game";
import { AUTO_SCOUT_LEVEL } from "@/lib/colony/reserve";
import { ticketNotes } from "./notes";

/**
 * Scouts end to end, on the in-memory store and a mock GitHub: several
 * attempts at one ticket, the Reviewer Agent keeps one as the ticket's pull
 * request, and the person can swap it.
 */

const PROJECT = "project_default";
const REPO = "acme/widgets";
const NO_USAGE = { model: "stub", tokensIn: 0, tokensOut: 0, costCents: 0 };

/** Writes a change shaped by the approach its notes give it; fails where told to. */
class FollowsItsApproach implements CoderAgent {
  readonly briefs: string[] = [];
  constructor(private readonly fails: (approach: string) => boolean = () => false) {}

  async implement(_ctx: AgentContext, input: { task: CoderTask; workspace: Workspace }): Promise<AgentOutcome<CodeChange>> {
    const approach = input.task.notes?.at(-1) ?? "";
    this.briefs.push(approach);
    if (this.fails(approach)) return { ok: false, blocked: false, error: "Could not find a way.", usage: NO_USAGE };
    const dir = input.task.fileScope[0]!;
    await input.workspace.writeFile(`${dir}/a.ts`, "export const a = 1;\n");
    if (/robust/.test(approach)) await input.workspace.writeFile(`${dir}/a.test.ts`, "// tests\n");
    return {
      ok: true,
      value: { summary: /robust/.test(approach) ? "with tests" : "small", detail: "", verifiedWith: null, handoff: [] },
      usage: NO_USAGE,
    };
  }
}

/**
 * Picks a scout by a rule the test sets. Its reviews never answer, so the
 * pick's pull request stays in review for the test to look at.
 */
class Picks implements ReviewerAgent {
  seen: ScoutCandidate[] = [];
  constructor(private readonly choose: (c: ScoutCandidate[]) => string) {}

  review(_ctx: AgentContext, _input: ReviewTask): Promise<AgentOutcome<ReviewVerdict>> {
    return new Promise(() => {});
  }

  async compare(
    _ctx: AgentContext,
    input: { task: CoderTask; candidates: ScoutCandidate[] },
  ): Promise<AgentOutcome<ScoutVerdict>> {
    this.seen = input.candidates;
    return {
      ok: true,
      value: { pick: this.choose(input.candidates), why: "It has tests.", lessons: ["The db module wants a test beside it."] },
      usage: NO_USAGE,
    };
  }
}

function useAgents(coder: CoderAgent, reviewer: ReviewerAgent) {
  setAgents({
    product: new MockProductAgent(),
    architect: new MockArchitectAgent(),
    coder,
    reviewer,
    showcase: new MockShowcaseAgent(),
  });
}

async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function ticket() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Db", rawRequest: "Db", position: 1 });
  const [made] = await repo.createTickets([
    {
      epicId: epic.id,
      key: "T-1",
      title: "Schema",
      description: "Schema",
      acceptanceCriteria: ["a"],
      fileScope: ["src/db"],
      size: "S",
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  return made!;
}

/** Several scouts at once are what the judge compares: set them out as a ticket's start would. */
async function sendTwo(id: string) {
  const repo = repository();
  await repo.createScouts(id, [
    { brief: SCOUT_APPROACHES[0], presetId: null },
    { brief: SCOUT_APPROACHES[1], presetId: null },
  ]);
  await repo.updateTicket(id, { scouts: 2, status: "running" });
  void runCoderAgent(PROJECT, id);
}

/** A ticket whose attempt failed in In Progress. */
async function stopped(id: string) {
  await repository().updateTicket(id, { status: "failed", stalledIn: "in_progress" });
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetMergeLanes();
  resetAgents();
  resetVcs();
  resetPullRequestSweep();
  setVcs(new MockVcsClient(REPO));
  setCheckoutFactory(async (request) => {
    const raw = new MemoryWorkspace();
    return { workspace: scopedWorkspace(raw, request.ticket.fileScope), raw, sandboxId: null, async dispose() {} };
  });
});

describe("scouts", () => {
  it("sends each scout its own approach, keeps the Reviewer's pick as the pull request, and shares what it learned", async () => {
    const repo = repository();
    const coder = new FollowsItsApproach();
    const reviewer = new Picks((c) => c.find((x) => /robust/.test(x.approach))!.label);
    useAgents(coder, reviewer);
    const t = await ticket();

    await sendTwo(t.id);
    await until(async () => (await repo.ticketDetail(t.id))!.status === "review", "the pick to open its pull request");

    // Each scout was told its own approach, after the ticket's own notes.
    expect(coder.briefs).toHaveLength(2);
    expect(coder.briefs[0]).toMatch(/smallest change/);
    expect(coder.briefs[1]).toMatch(/most robust/);
    expect(reviewer.seen.map((c) => c.label)).toEqual(["S1", "S2"]);

    // Scouts are never cards; the ticket's pull request is the robust one's branch.
    const scouts = await repo.scoutsOf(t.id);
    expect((await repo.boardCards(PROJECT)).some((c) => scouts.some((s) => s.id === c.id))).toBe(false);
    const parent = (await repo.ticketDetail(t.id))!;
    const kept = scouts.find((s) => s.id === parent.scoutPick)!;
    expect(kept.summary).toBe("with tests");
    expect(parent.branchName).toBe(kept.branchName);
    expect(parent.prNumber).not.toBeNull();
    expect((await repo.cardChatMessages(t.id)).at(-1)?.content).toMatch(/Sent 2 scouts\. Kept S2: It has tests\./);

    const notes = await repo.eventsOfTypes([PROJECT], ["repo.note"], new Date(0));
    expect(notes.map((n) => (n.payload as { text: string }).text)).toContain("The db module wants a test beside it.");
  });

  it("lets the person swap the pick for another scout's change", async () => {
    const repo = repository();
    useAgents(new FollowsItsApproach(), new Picks((c) => c[0]!.label));
    const t = await ticket();
    await sendTwo(t.id);
    await until(async () => (await repo.ticketDetail(t.id))!.status === "review", "the pick");
    const before = (await repo.ticketDetail(t.id))!;
    const other = (await repo.scoutsOf(t.id)).find((s) => s.id !== before.scoutPick)!;

    expect(await swapScout(PROJECT, t.id, other.id)).toEqual({ ok: true });
    const after = (await repo.ticketDetail(t.id))!;
    expect(after.scoutPick).toBe(other.id);
    expect(after.branchName).toBe(other.branchName);
    expect(after.prNumber).not.toBe(before.prNumber);
  });

  it("keeps the only scout that came back, with no comparison", async () => {
    const repo = repository();
    const reviewer = new Picks(() => "S9");
    useAgents(new FollowsItsApproach((a) => /smallest/.test(a)), reviewer);
    const t = await ticket();
    await sendTwo(t.id);
    await until(async () => (await repo.ticketDetail(t.id))!.status === "review", "the pick");
    expect(reviewer.seen).toEqual([]);
    expect((await repo.ticketDetail(t.id))!.scoutWhy).toMatch(/only scout that came back/);
  });

  it("stops the ticket with every scout's reason when none came back, and works it the ordinary way after", async () => {
    const repo = repository();
    useAgents(new FollowsItsApproach(() => true), new Picks((c) => c[0]!.label));
    const t = await ticket();
    await sendTwo(t.id);
    await until(async () => (await repo.ticketDetail(t.id))!.status === "failed", "the ticket to stop");

    const parent = (await repo.ticketDetail(t.id))!;
    expect(parent.blockedReason).toMatch(/Every scout came back without a change\. S1 \(smallest\): Could not find a way\./);
    expect(parent.scouts).toBe(0);
    expect(await repo.scoutsOf(t.id)).toEqual([]);
    expect((await ticketNotes(PROJECT, t.id)).at(-1)?.text).toMatch(/Every scout came back/);
  });

  it("sends exactly one scout from In Progress, on the column's agent when no scout agent is set", async () => {
    const repo = repository();
    const coder = new FollowsItsApproach();
    useAgents(coder, new Picks((c) => c[0]!.label));
    const t = await ticket();
    await stopped(t.id);

    expect(await sendScouts(PROJECT, t.id)).toEqual({ ok: true });
    await until(async () => !!(await repo.ticketDetail(t.id))!.prNumber, "the scout's pull request");
    const scouts = await repo.scoutsOf(t.id);
    expect(scouts).toHaveLength(1);
    expect(scouts[0]!.scoutPresetId).toBeNull();
    expect(coder.briefs).toHaveLength(1);
  });

  it("runs the scout on the scout agent the board sets", async () => {
    const repo = repository();
    useAgents(new FollowsItsApproach(), new Picks((c) => c[0]!.label));
    const t = await ticket();
    await stopped(t.id);
    const preset = await repo.savePreset({
      ownerId: null,
      provider: "anthropic",
      name: "Scout",
      model: "claude-opus-5",
      prompt: "p",
      apiKeyCipher: null,
      apiKeyHint: null,
    });
    await repo.setScoutAgent(PROJECT, preset.id);

    await sendScouts(PROJECT, t.id);
    expect((await repo.scoutsOf(t.id))[0]!.scoutPresetId).toBe(preset.id);
    expect((await repo.columnAgents(PROJECT)).in_progress ?? null).toBeNull();
  });

  it("refuses a ticket in To Do, Review or Done, or with a scout already out", async () => {
    const repo = repository();
    useAgents(new FollowsItsApproach(), new Picks((c) => c[0]!.label));
    const t = await ticket();
    const reason = "A scout goes out on a ticket in In Progress.";
    expect(await sendScouts(PROJECT, t.id)).toEqual({ ok: false, reason });
    await repo.updateTicket(t.id, { status: "review" });
    expect(await sendScouts(PROJECT, t.id)).toEqual({ ok: false, reason });
    await repo.updateTicket(t.id, { status: "merged" });
    expect(await sendScouts(PROJECT, t.id)).toEqual({ ok: false, reason });
    await stopped(t.id);
    await repo.createScouts(t.id, [{ brief: SCOUT_APPROACHES[0], presetId: null }]);
    expect((await sendScouts(PROJECT, t.id)).ok).toBe(false);
  });

  it("auto-scouts a failed ticket from idle reserve once the level unlocks it", async () => {
    const repo = repository();
    useAgents(new FollowsItsApproach(), new Picks((c) => c[0]!.label));
    const t = await ticket();
    await stopped(t.id);
    await repo.setColony(PROJECT, { colonySize: 6, colonyReserve: 0, autoScout: true });

    // Below the level, nothing goes out on its own.
    await autoScout(PROJECT);
    expect(await repo.scoutsOf(t.id)).toEqual([]);

    // Earn the level: merged work is what levels come from.
    const epic = await repo.createEpic({ projectId: PROJECT, title: "Done", rawRequest: "Done", position: 9 });
    for (let i = 0; scoreOf(await repo.boardCards(PROJECT)).level < AUTO_SCOUT_LEVEL; i++) {
      const [done] = await repo.createTickets([
        { epicId: epic.id, key: `D-${i}`, title: "d", description: "d", acceptanceCriteria: [], fileScope: [`src/d${i}`], size: "S", storyPoints: 13, position: i, dependsOnKeys: [] },
      ]);
      await repo.updateTicket(done!.id, { status: "merged" });
    }
    await repo.setColony(PROJECT, { colonySize: 6, colonyReserve: 0, autoScout: true });

    await autoScout(PROJECT);
    await until(async () => !!(await repo.ticketDetail(t.id))!.scoutPick && !!(await repo.ticketDetail(t.id))!.prNumber, "the auto-scouts' pick");
    expect(await repo.scoutsOf(t.id)).toHaveLength(1);
  });
});
