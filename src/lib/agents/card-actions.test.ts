import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyCardAction } from "./card-actions";
import { resetAgents } from "./registry";
import { repository } from "@/lib/db";
import type { TicketDetail } from "@/lib/db/repository";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";

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
