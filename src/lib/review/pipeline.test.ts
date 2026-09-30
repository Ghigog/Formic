import { beforeEach, describe, expect, it } from "vitest";

import { markMergedExternally, resetPullRequestSweep, reviewPullRequest } from "./pipeline";
import { resetMergeLanes } from "./lane";
import { repository } from "@/lib/db";
import { subscribe } from "@/lib/events/bus";
import type { FormicEvent } from "@/lib/domain/events";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";

/**
 * The merge gate: what happens to an approved pull request with auto-merge
 * off, when it is merged, and when a merge Formic attempts fails. On the
 * in-memory store and a mock GitHub.
 */

const PROJECT = "project_default";
const REPO = "acme/widgets";

let vcs: MockVcsClient;

beforeEach(() => {
  (globalThis as { __formicMemoryStore?: unknown }).__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetMergeLanes();
  resetVcs();
  resetPullRequestSweep();
  vcs = new MockVcsClient(REPO);
  setVcs(vcs);
});

/** An approved ticket in review with green CI, and one ticket waiting on it. */
async function seedApproved(autoMerge: boolean) {
  const repo = repository();
  (await repo.projectById(PROJECT))!.autoMerge = autoMerge;
  const epic = await repo.createEpic({ projectId: PROJECT, title: "E", rawRequest: "r", position: 1 });
  const base = {
    epicId: epic.id,
    description: "d",
    acceptanceCriteria: ["c"],
    fileScope: ["src"],
    storyPoints: 3,
    position: 1,
  };
  const [ticket, dependent] = await repo.createTickets([
    { ...base, key: "T-1", title: "First", dependsOnKeys: [] },
    { ...base, key: "T-2", title: "Second", dependsOnKeys: ["T-1"] },
  ]);
  const pull = await vcs.openPullRequest({ headBranch: "t-1", baseBranch: "main", title: "T-1", body: "" });
  const headSha = MockVcsClient.setChecks(pull.number, "success");
  await repo.updateTicket(ticket!.id, {
    status: "review",
    stage: 6,
    prNumber: pull.number,
    reviewedSha: headSha,
  });
  return { ticketId: ticket!.id, dependentId: dependent!.id, prNumber: pull.number, headSha };
}

function collectEvents() {
  const events: FormicEvent[] = [];
  subscribe(PROJECT, (e) => events.push(e.event));
  return events;
}

describe("the manual-merge gate", () => {
  it("leaves an approved pull request unmerged and shows the Merging stage", async () => {
    const { ticketId, prNumber, headSha } = await seedApproved(false);
    const events = collectEvents();

    await reviewPullRequest(PROJECT, prNumber, headSha);

    expect((await vcs.pullRequest(prNumber)).merged).toBe(false);
    const ticket = (await repository().ticketDetail(ticketId))!;
    expect(ticket.status).toBe("review");
    expect(ticket.stage).toBe(7);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "card.status", cardId: ticketId, status: "review", stage: 7 }),
    );
  });

  it("merges, marks the ticket merged and releases dependents once a person merges", async () => {
    const { ticketId, dependentId, prNumber, headSha } = await seedApproved(false);
    await reviewPullRequest(PROJECT, prNumber, headSha);
    expect((await repository().ticketDetail(dependentId))!.status).toBe("waiting");

    MockVcsClient.setPull(prNumber, { merged: true, state: "closed" });
    await markMergedExternally(PROJECT, prNumber);

    const ticket = (await repository().ticketDetail(ticketId))!;
    expect(ticket.status).toBe("merged");
    expect((await repository().cardById(ticketId))!.mergePoints).toBeGreaterThan(0);
    expect((await repository().ticketDetail(dependentId))!.status).toBe("ready");
  });

  it("merges by itself when auto-merge is on", async () => {
    const { ticketId, prNumber, headSha } = await seedApproved(true);

    await reviewPullRequest(PROJECT, prNumber, headSha);

    expect((await vcs.pullRequest(prNumber)).merged).toBe(true);
    expect((await repository().ticketDetail(ticketId))!.status).toBe("merged");
  });
});

describe("a merge that fails", () => {
  it("rolls the ticket back with the reason, awarding nothing and releasing nothing", async () => {
    const { ticketId, dependentId, prNumber, headSha } = await seedApproved(true);
    vcs.merge = async () => ({ ok: false, reason: "Required review missing.", conflict: false });
    const events = collectEvents();

    await reviewPullRequest(PROJECT, prNumber, headSha);

    const ticket = (await repository().ticketDetail(ticketId))!;
    expect(ticket.status).toBe("blocked");
    expect(ticket.stage).toBe(6);
    expect(ticket.blockedReason).toContain("Required review missing.");
    expect((await repository().cardById(ticketId))!.mergePoints ?? null).toBeNull();
    expect((await repository().ticketDetail(dependentId))!.status).toBe("waiting");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "card.status",
        cardId: ticketId,
        blockedReason: expect.stringContaining("Required review missing."),
      }),
    );
  });
});
