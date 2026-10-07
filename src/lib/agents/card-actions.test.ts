import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyCardAction, cardActionSchema } from "./card-actions";
import type { TicketSpec } from "./decomposition";
import { resetAgents, setAgents } from "./registry";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";
import type { AgentContext, AgentOutcome, CodeChange, CoderAgent, CoderTask } from "@/lib/agents/ports";
import type { Workspace } from "@/lib/sandbox/workspace";
import { MockArchitectAgent, MockProductAgent, MockReviewerAgent, MockShowcaseAgent } from "@/lib/agents/mock";

/**
 * "Merge it" in a ticket's chat merges its pull request. The ticket reaches
 * Done only once GitHub has merged it, never by being closed around it.
 */

const PROJECT = "project_default";

/** T-1 in review with an open pull request, and T-2 waiting on it. */
async function seedInReview(): Promise<{ ticket: TicketDetail; next: TicketDetail; prNumber: number }> {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "An epic", rawRequest: "Do a thing", position: 1 });
  const [a, b] = await repo.createTickets([
    {
      epicId: epic.id,
      key: "T-1",
      title: "Do the thing",
      description: "Ship it.",
      acceptanceCriteria: ["It is done"],
      fileScope: ["src/lib/feature"],
      size: "M",
      storyPoints: 3,
      position: 1,
      dependsOnKeys: [],
    },
    {
      epicId: epic.id,
      key: "T-2",
      title: "Then the next",
      description: "Build on it.",
      acceptanceCriteria: ["It is done"],
      fileScope: ["src/lib/other"],
      size: "S",
      storyPoints: 1,
      position: 2,
      dependsOnKeys: ["T-1"],
    },
  ]);
  const pull = await new MockVcsClient("acme/widgets").openPullRequest({
    title: "T-1",
    body: "",
    headBranch: "formic/t-1",
    baseBranch: "main",
  });
  await repo.updateTicket(a!.id, { status: "review", prNumber: pull.number });
  return {
    ticket: (await repo.ticketDetail(a!.id))!,
    next: (await repo.ticketDetail(b!.id))!,
    prNumber: pull.number,
  };
}

/**
 * A coder that does whatever the test tells it to, so a run started by an
 * action can be seen to have started.
 */
class StubCoder implements CoderAgent {
  tasks: CoderTask[] = [];

  constructor(private readonly act: (workspace: Workspace, task: CoderTask) => Promise<void>) {}

  async implement(_ctx: AgentContext, input: { task: CoderTask; workspace: Workspace }): Promise<AgentOutcome<CodeChange>> {
    this.tasks.push(input.task);
    await this.act(input.workspace, input.task);
    return {
      ok: true,
      value: { summary: "did the thing", detail: "details", verifiedWith: "npm test", handoff: [] },
      usage: { model: "stub", tokensIn: 0, tokensOut: 0, costCents: 0 },
    };
  }
}

/** T-1 blocked in To Do, asking for a file outside its scope. */
async function seedBlocked(): Promise<TicketDetail> {
  const repo = repository();
  const epic = await repo.createEpic({ projectId: PROJECT, title: "An epic", rawRequest: "Do a thing", position: 1 });
  const [a] = await repo.createTickets([
    {
      epicId: epic.id,
      key: "T-1",
      title: "Do the thing",
      description: "Ship it.",
      acceptanceCriteria: ["It is done"],
      fileScope: ["src/lib/feature"],
      size: "M",
      storyPoints: 3,
      position: 1,
      dependsOnKeys: [],
    },
  ]);
  await repo.updateTicket(a!.id, {
    status: "blocked",
    stalledIn: "todo",
    blockedReason: "Needs files outside its scope: `src/app/page.tsx`, `src/lib/other/thing.ts`.",
    scopeRequest: ["src/app/page.tsx", "src/lib/other/thing.ts"],
  });
  return (await repo.ticketDetail(a!.id))!;
}

/** Waits for detached work (launch()) to reach a state, or gives up loudly. */
async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

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

describe("editing a ticket's story points", () => {
  it("sets them and says story points changed", async () => {
    const { ticket } = await seedInReview();

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, { type: "edit_ticket", storyPoints: 5 });

    expect(said).toContain("story points");
    expect((await repository().ticketDetail(ticket.id))!.storyPoints).toBe(5);
  });

  it("rejects a value off the scale, so the ticket stays as it was", async () => {
    const { ticket } = await seedInReview();

    expect(cardActionSchema.safeParse({ type: "edit_ticket", storyPoints: 4 }).success).toBe(false);
    expect(cardActionSchema.safeParse({ type: "edit_ticket", storyPoints: 13 }).success).toBe(true);
    expect((await repository().ticketDetail(ticket.id))!.storyPoints).toBe(3);
  });
});

describe("moving a ticket with a pull request to Done", () => {
  it("merges the pull request, then puts the ticket in Done and frees what waits on it", async () => {
    const { ticket, next, prNumber } = await seedInReview();

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, { type: "move", to: "done" });

    expect(said).toContain(`Merged pull request #${prNumber}`);
    expect((await new MockVcsClient("acme/widgets").pullRequest(prNumber)).merged).toBe(true);
    expect((await repository().ticketDetail(ticket.id))!.status).toBe("merged");
    expect((await repository().ticketDetail(next.id))!.status).toBe("ready");
  });

  it("leaves the ticket where it is when GitHub refuses the merge", async () => {
    const { ticket, prNumber } = await seedInReview();
    MockVcsClient.setChecks(prNumber, "failure");

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, { type: "move", to: "done" });

    expect(said).toContain("Red CI does not merge");
    expect((await new MockVcsClient("acme/widgets").pullRequest(prNumber)).merged).toBe(false);
    expect((await repository().ticketDetail(ticket.id))!.status).not.toBe("merged");
  });

  it("merges the open pull request of a ticket already in Done", async () => {
    const { ticket, prNumber } = await seedInReview();
    await repository().updateTicket(ticket.id, { status: "merged" });

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, { type: "move", to: "done" });

    expect(said).toContain(`Merged pull request #${prNumber}`);
    expect((await new MockVcsClient("acme/widgets").pullRequest(prNumber)).merged).toBe(true);
  });
});

describe("moving a stopped card to the column it stopped in", () => {
  it("starts the Coder Agent again on a ticket that failed in In Progress", async () => {
    const { ticket } = await seedInReview();
    await repository().updateTicket(ticket.id, {
      status: "failed",
      stalledIn: "in_progress",
      blockedReason: "Claude Code hit its usage limit.",
    });

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, { type: "move", to: "in_progress" });

    expect(said).toContain("Starting the Coder Agent on T-1 again");
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).not.toBe("failed");
    expect(after.blockedReason).toBeNull();
  });

  it("starts the Product Agent again on an Epic that failed in Backlog", async () => {
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "An epic", rawRequest: "Do a thing", position: 1 });
    await repo.move({ cardId: epic.id, kind: "epic", status: "failed", stalledIn: "backlog", position: 1 });

    const said = await applyCardAction(PROJECT, "epic", epic.id, { type: "move", to: "backlog" });

    expect(said).toContain("again");
    expect((await repo.cardById(epic.id))!.status).toBe("draft");
  });

  it("still says a working card is already there", async () => {
    const { ticket } = await seedInReview();

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, { type: "move", to: "in_review" });

    expect(said).toBe("T-1 is already in In Review.");
  });
});

describe("editing a ticket that is asking for files outside its scope", () => {
  const useStubCoder = (): StubCoder => {
    const coder = new StubCoder(async (workspace, task) => {
      await workspace.writeFile(`${task.fileScope[0]}/thing.ts`, "export const a = 1;\n");
    });
    setAgents({
      product: new MockProductAgent(),
      architect: new MockArchitectAgent(),
      coder,
      reviewer: new MockReviewerAgent(),
      showcase: new MockShowcaseAgent(),
    });
    return coder;
  };

  it("resolves the block and starts the Coder Agent when the new scope covers what it asked for", async () => {
    const coder = useStubCoder();
    const ticket = await seedBlocked();

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "edit_ticket",
      fileScope: ["src/app/page.tsx", "src/lib/feature", "src/lib/other/thing.ts"],
    });

    expect(said).toContain("Updated T-1's file scope");
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.status).not.toBe("blocked");
    expect(after.stalledIn).toBeNull();
    expect(after.blockedReason).toBeNull();
    expect(after.scopeRequest).toEqual([]);
    await until(async () => coder.tasks.length > 0, "the Coder Agent to start");
    expect((await repository().ticketDetail(ticket.id))!.status).not.toBe("ready");
  });

  it("queues it behind a ticket running in those files", async () => {
    useStubCoder();
    const ticket = await seedBlocked();
    const repo = repository();
    const [other] = await repo.createTickets([
      {
        epicId: ticket.epicId,
        key: "T-2",
        title: "The page",
        description: "The page.",
        acceptanceCriteria: ["It shows"],
        fileScope: ["src/app"],
        size: "M",
        position: 2,
        dependsOnKeys: [],
      },
    ]);
    await repo.updateTicket(other!.id, { status: "running" });

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "edit_ticket",
      fileScope: ["src/app/page.tsx", "src/lib/feature", "src/lib/other/thing.ts"],
    });

    expect(said).toContain("queued behind T-2");
    const after = (await repo.ticketDetail(ticket.id))!;
    expect(after.status).toBe("queued");
    expect(after.scopeRequest).toEqual([]);
    expect(after.blockedReason).toBeNull();
  });

  it("carries kept work on rather than doing it again", async () => {
    const coder = useStubCoder();
    const ticket = await seedBlocked();
    await repository().updateTicket(ticket.id, { branchName: "formic/t-1" });
    MockVcsClient.stage("formic/t-1", ["src/lib/feature/thing.ts", "src/app/page.tsx"], "T-1: did the thing\n\ndetails");

    await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "edit_ticket",
      fileScope: ["src/app/page.tsx", "src/lib/feature", "src/lib/other/thing.ts"],
    });

    await until(
      async () => !!(await repository().ticketDetail(ticket.id))?.prNumber,
      "the kept work's pull request",
    );
    expect(coder.tasks).toHaveLength(0);
  });

  it("stays blocked when the new scope covers only part of what it asked for", async () => {
    useStubCoder();
    const ticket = await seedBlocked();

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "edit_ticket",
      fileScope: ["src/lib/feature", "src/lib/other/thing.ts"],
    });

    expect(said).toContain("Updated T-1's file scope");
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.fileScope).toEqual(["src/lib/feature", "src/lib/other/thing.ts"]);
    expect(after.status).toBe("blocked");
    expect(after.stalledIn).toBe("todo");
    expect(after.scopeRequest).toEqual(["src/app/page.tsx"]);
  });

  it("leaves a ticket with no scope request working the way it always has", async () => {
    const ticket = await seedBlocked();
    await repository().updateTicket(ticket.id, { status: "ready", stalledIn: null, blockedReason: null, scopeRequest: [] });

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "edit_ticket",
      fileScope: ["src/lib/wider"],
    });

    expect(said).toBe("Updated T-1's file scope.");
    const after = (await repository().ticketDetail(ticket.id))!;
    expect(after.fileScope).toEqual(["src/lib/wider"]);
    expect(after.status).toBe("ready");
    expect(after.stalledIn).toBeNull();
    expect(after.scopeRequest).toEqual([]);
  });
});

describe("splitting a ticket", () => {
  /** A plain, unstarted ticket in To Do. */
  async function seedReady(): Promise<TicketDetail> {
    const repo = repository();
    const epic = await repo.createEpic({ projectId: PROJECT, title: "An epic", rawRequest: "Do a thing", position: 1 });
    const [a] = await repo.createTickets([
      {
        epicId: epic.id,
        key: "T-1",
        title: "Do the thing",
        description: "Ship it.",
        acceptanceCriteria: ["It is done"],
        fileScope: ["src/lib/feature"],
        size: "M",
        storyPoints: 5,
        position: 1,
        dependsOnKeys: [],
      },
    ]);
    return (await repo.ticketDetail(a!.id))!;
  }

  function spec(key: string, fileScope: string[], dependsOn: string[] = []): TicketSpec {
    return {
      key,
      title: `${key} title`,
      userStory: { as: "a board owner", want: "a thing", soThat: "it works" },
      requirements: [],
      acceptanceCriteria: [{ given: "a board", when: "I use it", then: "it works" }],
      fileScope,
      storyPoints: 2,
      dependsOn,
    };
  }

  it("replaces the ticket with the split children on the same Epic", async () => {
    const ticket = await seedReady();
    const repo = repository();
    const before = (await repo.cardById(ticket.id))!;

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "split_ticket",
      tickets: [spec("T-1A", ["src/lib/feature/a"]), spec("T-1B", ["src/lib/feature/b"])],
    });

    expect(said).toBe("Split T-1 into T-1A, T-1B.");
    expect(await repo.cardById(ticket.id)).toBeNull();
    const children = (await repo.boardCards(PROJECT)).filter((c) => c.epicId === ticket.epicId);
    expect(children.map((c) => c.key).sort()).toEqual(["T-1A", "T-1B"]);
    // The first child keeps the original's place, and both stay under the Epic.
    expect(children.find((c) => c.key === "T-1A")!.position).toBe(before.position);
  });

  it("splits a ticket whose agent stopped with a branch but no pull request", async () => {
    const ticket = await seedReady();
    await repository().updateTicket(ticket.id, { branchName: "formic/t-1", status: "failed", stalledIn: "todo" });

    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "split_ticket",
      tickets: [spec("T-1A", ["src/lib/feature/a"]), spec("T-1B", ["src/lib/feature/b"])],
    });

    expect(said).toBe("Split T-1 into T-1A, T-1B.");
    expect(await repository().cardById(ticket.id)).toBeNull();
  });

  it("points a dependency at an existing ticket on the Epic", async () => {
    const ticket = await seedReady();
    const repo = repository();
    const [existing] = await repo.createTickets([
      {
        epicId: ticket.epicId,
        key: "T-0",
        title: "Earlier",
        description: "Already there.",
        acceptanceCriteria: ["Done"],
        fileScope: ["src/lib/earlier"],
        size: "M",
        position: 0,
        dependsOnKeys: [],
      },
    ]);

    await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "split_ticket",
      tickets: [spec("T-1A", ["src/lib/feature/a"]), spec("T-1B", ["src/lib/feature/b"], ["T-0"])],
    });

    const b = (await repo.boardCards(PROJECT)).find((c) => c.key === "T-1B")!;
    expect(b.dependsOn).toEqual([existing!.id]);
    expect(b.status).toBe("waiting");
  });

  it("refuses a ticket with an open pull request", async () => {
    const { ticket } = await seedInReview();
    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "split_ticket",
      tickets: [spec("T-1A", ["src/lib/feature/a"]), spec("T-1B", ["src/lib/feature/b"])],
    });
    expect(said).toContain("open pull request");
  });

  it("refuses a split whose children could run together on the same files", async () => {
    const ticket = await seedReady();
    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "split_ticket",
      tickets: [spec("T-1A", ["src/lib/feature"]), spec("T-1B", ["src/lib/feature"])],
    });
    expect(said).toContain("not safe to run");
    expect(await repository().cardById(ticket.id)).not.toBeNull();
  });

  it("refuses a split whose dependency names nothing", async () => {
    const ticket = await seedReady();
    const said = await applyCardAction(PROJECT, "ticket", ticket.id, {
      type: "split_ticket",
      tickets: [spec("T-1A", ["src/lib/a"]), spec("T-1B", ["src/lib/b"], ["NOPE"])],
    });
    expect(said).toContain("not safe to run");
  });
});
