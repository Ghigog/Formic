import { beforeEach, describe, expect, it } from "vitest";
import { runCoderAgent } from "./pipeline";
import { setCheckoutFactory } from "./checkout";
import { MemoryWorkspace, scopedWorkspace, type Workspace } from "@/lib/sandbox/workspace";
import { resetMergeLanes } from "@/lib/review/lane";
import { mergeByPerson, resetPullRequestSweep } from "@/lib/review/pipeline";
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
import { MockVcsClient, mergeTarget, resetVcs, setVcs } from "@/lib/vcs";
import { restackOnto } from "./stack";
import { MockArchitectAgent, MockProductAgent, MockShowcaseAgent } from "@/lib/agents/mock";
import { projectFor } from "@/lib/board/project";

/**
 * Stacked pull requests end to end, on the in-memory store and a mock
 * GitHub: a ticket builds on the open pull request of the one it depends
 * on, and moves onto the base branch when that one merges.
 */

const PROJECT = "project_default";
const REPO = "acme/widgets";
const NO_USAGE = { model: "stub", tokensIn: 0, tokensOut: 0, costCents: 0 };

class WritesInScope implements CoderAgent {
  async implement(_ctx: AgentContext, input: { task: CoderTask; workspace: Workspace }): Promise<AgentOutcome<CodeChange>> {
    await input.workspace.writeFile(`${input.task.fileScope[0]}/thing.ts`, "export const a = 1;\n");
    return { ok: true, value: { summary: "did it", detail: "", verifiedWith: null, handoff: [] }, usage: NO_USAGE };
  }
}

/** Approves everything, except that a review of T-1 waits until the test lets it finish. */
class Approves implements ReviewerAgent {
  private release!: () => void;
  readonly held = new Promise<void>((r) => (this.release = r));

  finishFirst(): void {
    this.release();
  }

  async review(_ctx: AgentContext, input: ReviewTask): Promise<AgentOutcome<ReviewVerdict>> {
    if (input.task.key === "T-1") await this.held;
    return { ok: true, value: { summary: "fine", detail: "", verifiedWith: null, sendBack: null }, usage: NO_USAGE };
  }
}

let reviewer: Approves;

function recordCheckouts() {
  const from: string[] = [];
  setCheckoutFactory(async (request) => {
    from.push(`${request.fromBranch}${request.newBranch ? ` -> ${request.newBranch}` : ""}`);
    const raw = new MemoryWorkspace();
    return { workspace: scopedWorkspace(raw, request.ticket.fileScope), raw, sandboxId: null, async dispose() {} };
  });
  return from;
}

async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function chain() {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "Layers", rawRequest: "Schema, then API", position: 1 });
  const made = await repo.createTickets([
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
    {
      epicId: epic.id,
      key: "T-2",
      title: "API",
      description: "API",
      acceptanceCriteria: ["b"],
      fileScope: ["src/api"],
      size: "S",
      position: 2,
      dependsOnKeys: ["T-1"],
    },
  ]);
  return { first: made.find((t) => t.key === "T-1")!, second: made.find((t) => t.key === "T-2")! };
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetMergeLanes();
  resetAgents();
  resetVcs();
  resetPullRequestSweep();
  setCheckoutFactory(null);
  setVcs(new MockVcsClient(REPO));
  setAgents({
    product: new MockProductAgent(),
    architect: new MockArchitectAgent(),
    coder: new WritesInScope(),
    reviewer: (reviewer = new Approves()),
    showcase: new MockShowcaseAgent(),
  });
});

describe("stacked pull requests", () => {
  it("builds a dependent on its prerequisite's open pull request, and moves it onto the base once that merges", async () => {
    const repo = repository();
    const from = recordCheckouts();
    const base = (await projectFor(PROJECT)).baseBranch;
    const { first, second } = await chain();
    expect(second.status).toBe("waiting");

    // The first opens its pull request, and is still in review: the second
    // can build on it rather than wait for it to merge.
    await runCoderAgent(PROJECT, first.id);
    const one = (await repo.ticketDetail(first.id))!;
    expect(one.status).toBe("review");
    expect((await repo.cardById(second.id))?.status).toBe("ready");

    // It starts from the first's branch, and its pull request targets that
    // branch, so its diff is only its own layer.
    await runCoderAgent(PROJECT, second.id);
    const two = (await repo.ticketDetail(second.id))!;
    expect(from[0]).toBe(`${base} -> ${one.branchName}`);
    expect(from).toContain(`${one.branchName} -> ${two.branchName}`);
    expect(two.stackedOn).toBe(one.branchName);
    const client = new MockVcsClient(REPO);
    expect((await client.pullRequest(two.prNumber!)).baseBranch).toBe(one.branchName);
    expect(((await repo.cardChatMessages(second.id)).messages).at(-1)?.content).toMatch(/builds on it/);

    // Approved and green, it still does not merge ahead of the one under it.
    await until(async () => (await repo.ticketDetail(second.id))!.reviewedSha !== null, "the second to be approved");
    expect((await repo.ticketDetail(second.id))!.status).toBe("review");
    expect(await mergeByPerson(PROJECT, two, two.prNumber!)).toMatch(/stacked on/);

    // The first is approved and merges: the second now targets the base.
    reviewer.finishFirst();
    await until(async () => (await repo.ticketDetail(first.id))!.status === "merged", "the first to merge");
    expect((await client.pullRequest(two.prNumber!)).baseBranch).toBe(base);
    expect((await repo.ticketDetail(second.id))!.stackedOn).toBeNull();

    // And merges after it, through the same queue as any other.
    expect(await mergeByPerson(PROJECT, (await repo.ticketDetail(second.id))!, two.prNumber!)).toMatch(/^Merged/);
    expect((await repo.ticketDetail(second.id))!.status).toBe("merged");
  });

  it("starts from the base, unstacked, once the prerequisite has merged", async () => {
    const repo = repository();
    const from = recordCheckouts();
    const base = (await projectFor(PROJECT)).baseBranch;
    const { first, second } = await chain();
    await repo.updateTicket(first.id, { status: "merged" });

    await runCoderAgent(PROJECT, second.id);
    expect(from[0]).toMatch(new RegExp(`^${base} -> `));
    const two = (await repo.ticketDetail(second.id))!;
    expect(two.stackedOn).toBeNull();
    expect((await new MockVcsClient(REPO).pullRequest(two.prNumber!)).baseBranch).toBe(base);
  });

  it("brings the branch it builds on up to date first, when its other prerequisites merged after that branch was cut", async () => {
    const repo = repository();
    recordCheckouts();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "Swap", rawRequest: "Swap boards", position: 1 });
    const made = await repo.createTickets([
      { epicId: epic.id, key: "T-1", title: "Server", description: "s", acceptanceCriteria: ["a"], fileScope: ["src/server"], size: "S", position: 1, dependsOnKeys: [] },
      { epicId: epic.id, key: "T-2", title: "Gestures", description: "g", acceptanceCriteria: ["b"], fileScope: ["src/gestures"], size: "S", position: 2, dependsOnKeys: [] },
      { epicId: epic.id, key: "T-3", title: "Wire it", description: "w", acceptanceCriteria: ["c"], fileScope: ["src/wire"], size: "S", position: 3, dependsOnKeys: ["T-1", "T-2"] },
    ]);
    const [one, two, three] = ["T-1", "T-2", "T-3"].map((k) => made.find((t) => t.key === k)!);
    await runCoderAgent(PROJECT, one!.id);
    await repo.updateTicket(two!.id, { status: "merged" });

    await runCoderAgent(PROJECT, three!.id);

    const below = (await repo.ticketDetail(one!.id))!.branchName!;
    expect((await repo.ticketDetail(three!.id))!.stackedOn).toBe(below);
    const merges = (globalThis as unknown as { __formicMockRepo: { merges: Array<{ base: string; head: string }> } }).__formicMockRepo.merges;
    expect(merges).toContainEqual({ base: below, head: mergeTarget((await projectFor(PROJECT)).baseBranch) });
  });

  it("stops and says why when that branch cannot take in the merged work", async () => {
    const repo = repository();
    recordCheckouts();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "Swap", rawRequest: "Swap boards", position: 1 });
    const made = await repo.createTickets([
      { epicId: epic.id, key: "T-1", title: "Server", description: "s", acceptanceCriteria: ["a"], fileScope: ["src/server"], size: "S", position: 1, dependsOnKeys: [] },
      { epicId: epic.id, key: "T-2", title: "Gestures", description: "g", acceptanceCriteria: ["b"], fileScope: ["src/gestures"], size: "S", position: 2, dependsOnKeys: [] },
      { epicId: epic.id, key: "T-3", title: "Wire it", description: "w", acceptanceCriteria: ["c"], fileScope: ["src/wire"], size: "S", position: 3, dependsOnKeys: ["T-1", "T-2"] },
    ]);
    const [one, two, three] = ["T-1", "T-2", "T-3"].map((k) => made.find((t) => t.key === k)!);
    await runCoderAgent(PROJECT, one!.id);
    await repo.updateTicket(two!.id, { status: "merged" });
    const below = (await repo.ticketDetail(one!.id))!.branchName!;
    MockVcsClient.conflictOn(below, mergeTarget((await projectFor(PROJECT)).baseBranch));

    await runCoderAgent(PROJECT, three!.id);

    const after = (await repo.ticketDetail(three!.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("could not take in the work merged since it was cut");
  });

  describe("restacking onto the merge target", () => {
    /** A sandbox whose git is scripted: records commands, fails the rebase on demand. */
    function fakeSandbox(opts: { conflict: boolean }) {
      const commands: string[] = [];
      let disposed = false;
      setCheckoutFactory(async (request) => {
        const memory = new MemoryWorkspace();
        const raw: Workspace = {
          id: "fake",
          readFile: (path) => memory.readFile(path),
          writeFile: (path, contents) => memory.writeFile(path, contents),
          changedFiles: () => memory.changedFiles(),
          diff: (path) => memory.diff(path),
          async exec(command) {
            commands.push(command);
            const failed = opts.conflict && command.includes(" rebase --onto ");
            return { exitCode: failed ? 1 : 0, stdout: "", stderr: failed ? "CONFLICT" : "", timedOut: false };
          },
        };
        return { workspace: scopedWorkspace(raw, request.ticket.fileScope), raw, sandboxId: "sbx", async dispose() { disposed = true; } };
      });
      return { commands, disposed: () => disposed };
    }

    async function stackedPair() {
      const repo = repository();
      recordCheckouts();
      const { first, second } = await chain();
      await runCoderAgent(PROJECT, first.id);
      await runCoderAgent(PROJECT, second.id);
      await repo.updateTicket(first.id, { status: "merged" });
      return {
        one: (await repo.ticketDetail(first.id))!,
        two: (await repo.ticketDetail(second.id))!,
        base: mergeTarget((await projectFor(PROJECT)).baseBranch),
      };
    }

    it("replays only the ticket's own commits, cut at the head of the one below, and force-pushes with lease", async () => {
      const { one, two, base } = await stackedPair();
      const client = new MockVcsClient(REPO);
      const cut = (await client.pullRequest(one.prNumber!)).headSha;
      const before = (await client.pullRequest(two.prNumber!)).headSha;
      const sandbox = fakeSandbox({ conflict: false });

      await restackOnto(PROJECT, one, client, base);

      const rebase = sandbox.commands.find((c) => c.includes(" rebase --onto "))!;
      expect(rebase).toContain(`'origin/${base}' '${cut}' '${two.branchName}'`);
      expect(sandbox.commands.at(-1)).toBe(`git push --force-with-lease origin '${two.branchName}'`);
      expect(sandbox.commands).not.toContain("git rebase --abort");
      expect(sandbox.disposed()).toBe(true);
      expect((await client.pullRequest(two.prNumber!)).baseBranch).toBe(base);
      expect((await repository().ticketDetail(two.id))!.stackedOn).toBeNull();
      // The rebase did the bringing-up-to-date: the branch head is untouched.
      expect((await client.pullRequest(two.prNumber!)).headSha).toBe(before);
    });

    it("aborts a conflicting rebase and falls back to retargeting and updating the branch", async () => {
      const { one, two, base } = await stackedPair();
      const client = new MockVcsClient(REPO);
      MockVcsClient.behindBase(two.prNumber!);
      const before = (await client.pullRequest(two.prNumber!)).headSha;
      const sandbox = fakeSandbox({ conflict: true });

      await restackOnto(PROJECT, one, client, base);

      expect(sandbox.commands).toContain("git rebase --abort");
      expect(sandbox.commands.some((c) => c.includes("--force-with-lease"))).toBe(false);
      expect((await client.pullRequest(two.prNumber!)).baseBranch).toBe(base);
      expect((await client.pullRequest(two.prNumber!)).headSha).not.toBe(before);
      expect((await repository().ticketDetail(two.id))!.stackedOn).toBeNull();
    });

    /** Three tickets, each stacked on the one before, each approved on its head `old-<branch>`. */
    async function threeHigh() {
      const repo = repository();
      recordCheckouts();
      const epic = await repo.createEpic({ projectId: PROJECT, title: "Layers", rawRequest: "Schema, API, UI", position: 1 });
      const [first, second, third] = await repo.createTickets(
        [["T-1", "src/db", []], ["T-2", "src/api", ["T-1"]], ["T-3", "src/ui", ["T-2"]]].map(([key, scope, deps], i) => ({
          epicId: epic.id,
          key: key as string,
          title: key as string,
          description: key as string,
          acceptanceCriteria: ["a"],
          fileScope: [scope as string],
          size: "S" as const,
          position: i + 1,
          dependsOnKeys: deps as string[],
        })),
      ) as unknown as [{ id: string }, { id: string }, { id: string }];
      await runCoderAgent(PROJECT, first.id);
      await runCoderAgent(PROJECT, second.id);
      await runCoderAgent(PROJECT, third.id);
      const [one, two, three] = await Promise.all([first.id, second.id, third.id].map((id) => repo.ticketDetail(id)));
      // Let their reviews finish before the test sets the approvals it wants.
      await until(async () => (await repo.ticketDetail(three!.id))!.reviewedSha !== null && (await repo.ticketDetail(second.id))!.reviewedSha !== null, "T-2 and T-3 to be approved");
      for (const t of [two!, three!]) await repo.updateTicket(t.id, { reviewedSha: `old-${t.branchName}` });
      await repo.updateTicket(one!.id, { status: "merged" });
      return { one: one!, two: (await repo.ticketDetail(two!.id))!, three: (await repo.ticketDetail(three!.id))! };
    }

    /** Git, scripted: heads move on rebase, and a patch is the same unless the test says a branch's changed. */
    function scriptedGit(opts: { conflictOn?: string; patchChangedOn?: string }) {
      const commands: string[] = [];
      const rebased = new Set<string>();
      setCheckoutFactory(async (request) => {
        const memory = new MemoryWorkspace();
        const raw: Workspace = {
          id: "fake",
          readFile: (path) => memory.readFile(path),
          writeFile: (path, contents) => memory.writeFile(path, contents),
          changedFiles: () => memory.changedFiles(),
          diff: (path) => memory.diff(path),
          async exec(command) {
            commands.push(command);
            const out = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: exitCode ? "CONFLICT" : "", timedOut: false });
            const branch = /rebase --onto '[^']+' '[^']+' '([^']+)'/.exec(command)?.[1];
            if (branch) {
              if (branch === opts.conflictOn) return out("", 1);
              rebased.add(branch);
              return out("");
            }
            const head = /git rev-parse '([^']+)'/.exec(command)?.[1];
            if (head) return out(`${rebased.has(head) ? "new" : "old"}-${head}`);
            const mergeBase = /merge-base 'origin\/([^']+)'/.exec(command)?.[1];
            if (mergeBase) return out(`cut-${mergeBase}`);
            if (command.includes("patch-id")) {
              const changed = opts.patchChangedOn && command.includes(`'${opts.patchChangedOn}'`) && command.includes("'origin/");
              return out(changed ? "different" : "same");
            }
            return out("");
          },
        };
        return { workspace: scopedWorkspace(raw, request.ticket.fileScope), raw, sandboxId: "sbx", async dispose() {} };
      });
      return commands;
    }

    it("walks the whole stack in order when the bottom merges, keeping each approval whose change did not change", async () => {
      const { one, two, three, base } = { ...(await threeHigh()), base: mergeTarget((await projectFor(PROJECT)).baseBranch) };
      const client = new MockVcsClient(REPO);
      const cutOfTwo = (await client.pullRequest(one.prNumber!)).headSha;
      const commands = scriptedGit({});

      await restackOnto(PROJECT, one, client, base);

      const rebases = commands.filter((c) => c.includes(" rebase --onto "));
      expect(rebases).toHaveLength(2);
      expect(rebases[0]).toContain(`'origin/${base}' '${cutOfTwo}' '${two.branchName}'`);
      // T-3 goes onto T-2's rewritten branch, cut where its own commits begin on T-2's old head.
      expect(rebases[1]).toContain(`'origin/${two.branchName}' 'cut-${three.branchName}' '${three.branchName}'`);

      const repo = repository();
      expect((await repo.ticketDetail(two.id))!.reviewedSha).toBe(`new-${two.branchName}`);
      expect((await repo.ticketDetail(three.id))!.reviewedSha).toBe(`new-${three.branchName}`);
      // T-2 now targets the merge target; T-3 stays stacked on T-2, with its pull request base.
      expect((await client.pullRequest(two.prNumber!)).baseBranch).toBe(base);
      expect((await repo.ticketDetail(two.id))!.stackedOn).toBeNull();
      expect((await client.pullRequest(three.prNumber!)).baseBranch).toBe(two.branchName);
      expect((await repo.ticketDetail(three.id))!.stackedOn).toBe(two.branchName);
    });

    it("drops the approval of a ticket whose own patch changed in the rebase", async () => {
      const { one, two, three, base } = { ...(await threeHigh()), base: mergeTarget((await projectFor(PROJECT)).baseBranch) };
      scriptedGit({ patchChangedOn: three.branchName! });

      await restackOnto(PROJECT, one, new MockVcsClient(REPO), base);

      const repo = repository();
      expect((await repo.ticketDetail(two.id))!.reviewedSha).toBe(`new-${two.branchName}`);
      expect((await repo.ticketDetail(three.id))!.reviewedSha).toBe(`old-${three.branchName}`);
    });

    it("hands a conflicting rebase to the Reviewer Agent; only that ticket waits", async () => {
      const { one, two, three, base } = { ...(await threeHigh()), base: mergeTarget((await projectFor(PROJECT)).baseBranch) };
      const client = new MockVcsClient(REPO);
      scriptedGit({ conflictOn: three.branchName! });
      const handed: string[] = [];

      MockVcsClient.refuseBaseUpdate(three.prNumber!, "Merge conflict");

      await restackOnto(PROJECT, one, client, base, (id) => void handed.push(id));
      const repo = repository();
      expect(handed).toEqual([three.id]);
      expect((await repo.ticketDetail(two.id))!.reviewedSha).toBe(`new-${two.branchName}`);
      expect((await client.pullRequest(three.prNumber!)).baseBranch).toBe(two.branchName);
    });

    it("leaves a ticket that was never stacked alone", async () => {
      const { one, two, base } = await stackedPair();
      await repository().updateTicket(two.id, { stackedOn: null });
      const client = new MockVcsClient(REPO);
      const sandbox = fakeSandbox({ conflict: false });
      const head = (await client.pullRequest(two.prNumber!)).headSha;

      expect(await restackOnto(PROJECT, one, client, base)).toEqual([]);

      expect(sandbox.commands).toEqual([]);
      expect((await client.pullRequest(two.prNumber!)).headSha).toBe(head);
    });
  });
});
