import { beforeEach, describe, expect, it } from "vitest";

import { runCoderAgent } from "./pipeline";
import { setCheckoutFactory } from "./checkout";
import { reviewPullRequest } from "@/lib/review/pipeline";
import { resetMergeLanes } from "@/lib/review/lane";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
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
import {
  MemoryWorkspace,
  type Workspace,
  scopedWorkspace,
} from "@/lib/sandbox/workspace";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";
import {
  MockArchitectAgent,
  MockProductAgent,
  MockShowcaseAgent,
} from "@/lib/agents/mock";

/**
 * The Coder and Reviewer pipelines end to end, on the in-memory store and a
 * mock GitHub. What is being tested is the platform's half of PROT-06 and
 * PROT-07 — the file-scope check, the state transitions, the merge lane and
 * the retry ceiling — with the model replaced by a stub, because none of
 * those guarantees may depend on what a model happened to return.
 */

const PROJECT = "project_default";
const REPO = "acme/widgets";

const NO_USAGE = { model: "stub", tokensIn: 0, tokensOut: 0, costCents: 0 };

/** A coder that does whatever the test tells it to, to whichever workspace. */
class StubCoder implements CoderAgent {
  tasks: CoderTask[] = [];

  constructor(
    private readonly act: (
      workspace: Workspace,
      task: CoderTask,
    ) => Promise<void>,
    private readonly handoff: string[] = [],
  ) {}

  async implement(
    _ctx: AgentContext,
    input: { task: CoderTask; workspace: Workspace },
  ): Promise<AgentOutcome<CodeChange>> {
    this.tasks.push(input.task);
    await this.act(input.workspace, input.task);
    return {
      ok: true,
      value: {
        summary: "did the thing",
        detail: "details",
        verifiedWith: "npm test",
        handoff: this.handoff,
      },
      usage: NO_USAGE,
    };
  }
}

/**
 * A reviewer that does whatever the test tells it to. What it returns from
 * `act` is its reason to send the ticket back; nothing approves or fixes,
 * depending on whether it wrote anything.
 */
class StubReviewer implements ReviewerAgent {
  reviews: ReviewTask[] = [];

  constructor(
    private readonly act: (
      workspace: Workspace,
      input: ReviewTask,
    ) => Promise<string | void> = async () => {},
  ) {}

  async review(_ctx: AgentContext, input: ReviewTask): Promise<AgentOutcome<ReviewVerdict>> {
    this.reviews.push(input);
    const sendBack = await this.act(input.workspace, input);
    return {
      ok: true,
      value: { summary: "reviewed it", detail: "details", verifiedWith: null, sendBack: sendBack ?? null },
      usage: NO_USAGE,
    };
  }
}

const fixesInScope = async (workspace: Workspace, input: ReviewTask) => {
  await workspace.writeFile(`${input.task.fileScope[0]}/fix.ts`, "export const b = 2;\n");
};

function useAgents(coder: CoderAgent, reviewer: ReviewerAgent): void {
  setAgents({
    product: new MockProductAgent(),
    architect: new MockArchitectAgent(),
    coder,
    reviewer,
    showcase: new MockShowcaseAgent(),
  });
}

const writesInScope = (name = "thing.ts") =>
  async (workspace: Workspace, task: CoderTask) => {
    await workspace.writeFile(`${task.fileScope[0]}/${name}`, "export const a = 1;\n");
  };

async function seedTicket(options?: {
  fileScope?: string[];
  dependsOnKeys?: string[];
}): Promise<TicketDetail> {
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
      fileScope: options?.fileScope ?? ["src/lib/feature"],
      size: "M",
      position: 1,
      dependsOnKeys: options?.dependsOnKeys ?? [],
    },
  ]);
  return (await repo.ticketDetail(ticket!.id))!;
}

/** Waits for detached work (launch()) to reach a state, or gives up loudly. */
async function until(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

beforeEach(() => {
  // A fresh board per test: the in-memory store is a module global, which is
  // the point of it, and is also the thing that leaks between tests.
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetMergeLanes();
  resetAgents();
  resetVcs();
  setCheckoutFactory(null);
  setVcs(new MockVcsClient(REPO));
});

describe("the Coder Agent pipeline", () => {
  it("takes a ticket to a pull request, and on to merged once CI is green", async () => {
    useAgents(new StubCoder(writesInScope()), new StubReviewer());
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const afterCoder = (await repository().ticketDetail(ticket.id))!;
    expect(afterCoder.prNumber).toBeGreaterThan(0);
    expect(afterCoder.prUrl).toContain(REPO);
    expect(afterCoder.branchName).toMatch(/^formic\/t-1-/);
    expect(afterCoder.summary).toBe("did the thing");

    // With a mock GitHub no webhook arrives, so the pipeline drives the
    // review itself. The card should land in Done without further input.
    await until(async () => {
      const t = await repository().ticketDetail(ticket.id);
      return t?.status === "merged";
    }, "the ticket to merge");

    // Every ticket under the Epic has merged, so PROT-08's showcase runs.
    await until(async () => {
      const epic = await repository().cardById(ticket.epicId);
      return epic?.stage === 8;
    }, "the Epic showcase");
  });

  it("carries steps outside the repository through to the Epic's showcase", async () => {
    const step = "Add STRIPE_SECRET_KEY to the Vercel project's environment variables";
    useAgents(new StubCoder(writesInScope(), [step]), new StubReviewer());
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);
    expect((await repository().ticketDetail(ticket.id))!.handoff).toEqual([step]);

    await until(async () => (await repository().cardById(ticket.epicId))?.stage === 8, "the Epic showcase");
    const store = (globalThis as { __formicMemoryStore?: { showcases: Map<string, string> } })
      .__formicMemoryStore!;
    const showcase = store.showcases.get(ticket.epicId)!;
    expect(showcase.startsWith("## For you")).toBe(true);
    expect(showcase).toContain(`- [ ] ${step} (T-1)`);
  });

  it("throws the run away when the diff strays outside the file scope", async () => {
    // The agent goes around the scoped workspace — a shell can do this, which
    // is exactly why the diff is checked again before anything is pushed.
    const escaped = new MemoryWorkspace();
    setCheckoutFactory(async (request) => ({
      workspace: scopedWorkspace(escaped, request.ticket.fileScope),
      raw: escaped,
      sandboxId: null,
      async dispose() {},
    }));

    useAgents(
      new StubCoder(async () => {
        await escaped.writeFile("src/app/page.tsx", "export default null;");
      }),
      new StubReviewer(),
    );

    const ticket = await seedTicket({ fileScope: ["src/lib/feature"] });
    await runCoderAgent(PROJECT, ticket.id);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.stalledIn).toBe("in_progress");
    expect(after.blockedReason).toContain("src/app/page.tsx");
    expect(after.blockedReason).toContain("Nothing was pushed");
    // The decisive assertion: no pull request was opened.
    expect(after.prNumber).toBeNull();
  });

  it("fails a run that changed nothing rather than opening an empty pull request", async () => {
    useAgents(
      new StubCoder(async () => {}),
      new StubReviewer(),
    );
    const ticket = await seedTicket();

    await runCoderAgent(PROJECT, ticket.id);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("failed");
    expect(after.blockedReason).toContain("without changing anything");
    expect(after.prNumber).toBeNull();
  });

  it("runs two tickets with disjoint scopes without their changes meeting", async () => {
    useAgents(new StubCoder(writesInScope()), new StubReviewer());

    const repo = repository();
    const epic = await repo.createEpic({
      projectId: PROJECT,
      title: "Two tracks",
      rawRequest: "Two things at once",
      position: 1,
    });
    const created = await repo.createTickets([
      {
        epicId: epic.id,
        key: "T-1",
        title: "One",
        description: "One",
        acceptanceCriteria: ["a"],
        fileScope: ["src/lib/one"],
        size: "S",
        position: 1,
        dependsOnKeys: [],
      },
      {
        epicId: epic.id,
        key: "T-2",
        title: "Two",
        description: "Two",
        acceptanceCriteria: ["b"],
        fileScope: ["src/lib/two"],
        size: "S",
        position: 2,
        dependsOnKeys: [],
      },
    ]);

    await Promise.all(created.map((c) => runCoderAgent(PROJECT, c.id)));

    const details = await repo.ticketsForEpic(epic.id);
    const prNumbers = details.map((d) => d.prNumber);
    expect(prNumbers.every((n) => typeof n === "number")).toBe(true);
    expect(new Set(prNumbers).size).toBe(2);
  });
});

describe("the Reviewer Agent pipeline", () => {
  async function openPullRequestFor(ticket: TicketDetail, checksPass: boolean) {
    resetVcs();
    const client = new MockVcsClient(REPO, checksPass);
    setVcs(client);

    const pull = await client.openPullRequest({
      headBranch: "formic/t-1-abc123",
      baseBranch: "formic/integration",
      title: "T-1",
      body: "",
    });

    await repository().updateTicket(ticket.id, {
      status: "review",
      stage: 6,
      branchName: pull.headBranch,
      prNumber: pull.number,
      prUrl: pull.url,
    });

    return pull;
  }

  it("stops after the retry ceiling and says which check is failing", async () => {
    useAgents(new StubCoder(writesInScope()), new StubReviewer(fixesInScope));
    const ticket = await seedTicket();
    const pull = await openPullRequestFor(ticket, false);

    // Four red results on the same commit: three fixes, then the card stops.
    for (let i = 0; i < 4; i++) {
      await reviewPullRequest(PROJECT, pull.number, pull.headSha);
    }
    await until(
      async () => (await repository().ticketDetail(ticket.id))?.status === "blocked",
      "the card to stop",
    );

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.attempts).toBe(3);
    expect(after.status).toBe("blocked");
    expect(after.stalledIn).toBe("in_review");
    expect(after.blockedReason).toContain("ci / test");
    expect(after.blockedReason).toContain("needs a human");
  });

  it("ignores a result about a commit that is no longer the head", async () => {
    useAgents(new StubCoder(writesInScope()), new StubReviewer());
    const ticket = await seedTicket();
    const pull = await openPullRequestFor(ticket, false);

    await reviewPullRequest(PROJECT, pull.number, "a-sha-from-two-pushes-ago");

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.attempts).toBe(0);
    expect(after.status).toBe("review");
  });

  it("reviews a green pull request against the ticket before it merges", async () => {
    const reviewer = new StubReviewer();
    useAgents(new StubCoder(writesInScope()), reviewer);
    const ticket = await seedTicket();
    const pull = await openPullRequestFor(ticket, true);

    await reviewPullRequest(PROJECT, pull.number, pull.headSha);

    expect(reviewer.reviews).toHaveLength(1);
    expect(reviewer.reviews[0]!.checks).toEqual([]);
    expect(reviewer.reviews[0]!.task.acceptanceCriteria).toEqual(["It is done"]);
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("merged");
    expect(after.reviewedSha).toBe(pull.headSha);
  });

  it("hands the reviewer red CI, and stops when it has no fix", async () => {
    const reviewer = new StubReviewer();
    useAgents(new StubCoder(writesInScope()), reviewer);
    const ticket = await seedTicket();
    const pull = await openPullRequestFor(ticket, false);

    await reviewPullRequest(PROJECT, pull.number, pull.headSha);

    expect(reviewer.reviews[0]!.checks.map((c) => c.name)).toEqual(["ci / test"]);
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).toBe("blocked");
    expect(after.blockedReason).toContain("had no fix");
  });

  it("sends a ticket back to the Coder Agent with the reviewer's reason", async () => {
    let reviews = 0;
    const reviewer = new StubReviewer(async () =>
      ++reviews === 1 ? "The export ignores archived cards." : undefined,
    );
    const coder = new StubCoder(writesInScope());
    useAgents(coder, reviewer);
    const ticket = await seedTicket();
    const pull = await openPullRequestFor(ticket, true);

    await reviewPullRequest(PROJECT, pull.number, pull.headSha);

    await until(
      async () => (await repository().ticketDetail(ticket.id))?.status === "merged",
      "the reworked ticket to merge",
    );
    expect(reviews).toBe(2);
    // The coder was briefed with the reason, and worked on the same pull request.
    expect(coder.tasks[0]!.notes?.at(-1)).toContain("The export ignores archived cards.");
    expect((await repository().ticketDetail(ticket.id))!.prNumber).toBe(pull.number);
  });

  it("does not spend a fix attempt on a cancelled check", async () => {
    useAgents(new StubCoder(writesInScope()), new StubReviewer());
    const ticket = await seedTicket();
    const pull = await openPullRequestFor(ticket, false);

    // Nothing ran, so there is nothing to fix and nothing to merge.
    MockVcsClient.setChecks(pull.number, "cancelled");
    await reviewPullRequest(PROJECT, pull.number, pull.headSha);

    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.attempts).toBe(0);
    expect(after.status).toBe("review");
  });

  it("releases a dependent ticket when the one it waits on merges", async () => {
    useAgents(new StubCoder(writesInScope()), new StubReviewer());

    const repo = repository();
    const epic = await repo.createEpic({
      projectId: PROJECT,
      title: "Chained",
      rawRequest: "One then the other",
      position: 1,
    });
    const created = await repo.createTickets([
      {
        epicId: epic.id,
        key: "T-1",
        title: "First",
        description: "First",
        acceptanceCriteria: ["a"],
        fileScope: ["src/lib/one"],
        size: "S",
        position: 1,
        dependsOnKeys: [],
      },
      {
        epicId: epic.id,
        key: "T-2",
        title: "Second",
        description: "Second",
        acceptanceCriteria: ["b"],
        fileScope: ["src/lib/two"],
        size: "S",
        position: 2,
        dependsOnKeys: ["T-1"],
      },
    ]);

    const second = created.find((c) => c.key === "T-2")!;
    expect(second.status).toBe("waiting");

    const first = (await repo.ticketDetail(created[0]!.id))!;
    const pull = await openPullRequestFor(first, true);
    await reviewPullRequest(PROJECT, pull.number, pull.headSha);

    expect((await repo.ticketDetail(first.id))!.status).toBe("merged");
    expect((await repo.ticketDetail(second.id))!.status).toBe("ready");
  });

  it("treats a redelivered result as already handled", async () => {
    const repo = repository();
    expect(await repo.claimDelivery("7:abc:ci")).toBe(true);
    expect(await repo.claimDelivery("7:abc:ci")).toBe(false);
    expect(await repo.claimDelivery("7:def:ci")).toBe(true);
  });
});
