import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPrd, applyTickets } from "@/lib/agents/pipeline";
import { resetAgents } from "@/lib/agents/registry";
import { pullRequestBody } from "@/lib/coder/checkout";
import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";
import type { MockIssue } from "@/lib/vcs/mock";

/**
 * Epics and tickets mirrored as GitHub issues, on a mock GitHub: filed when
 * the card appears, labelled by column as it moves, commented at the moments
 * that matter, closed when it merges.
 */

const PROJECT = "project_default";

const PRD = {
  summary: "Let people export their board",
  problem: "Boards cannot leave Formic.",
  scope: ["A CSV export"],
  outOfScope: ["PDF"],
  technicalContext: [],
  userStories: [],
  successCriteria: ["The export opens in a spreadsheet"],
};

const TICKETS = [
  {
    key: "T-1",
    title: "Export endpoint",
    description: "Serve the CSV.",
    acceptanceCriteria: ["It downloads"],
    fileScope: ["src/app/api/export"],
    size: "S" as const,
    dependsOn: [],
  },
  {
    key: "T-2",
    title: "Export button",
    description: "A button that calls it.",
    acceptanceCriteria: ["It is on the board"],
    fileScope: ["src/components/export"],
    size: "S" as const,
    dependsOn: ["T-1"],
  },
];

function issues(): MockIssue[] {
  return [...MockVcsClient.runner().issues.values()];
}

function issue(number: number | null | undefined): MockIssue {
  const found = MockVcsClient.runner().issues.get(number ?? -1);
  if (!found) throw new Error(`No issue ${number}`);
  return found;
}

function comments(number: number | null | undefined): string[] {
  return MockVcsClient.runner().comments.get(number ?? -1) ?? [];
}

async function newEpic() {
  const epic = await repository().createEpic({
    projectId: PROJECT,
    title: "Export",
    rawRequest: "Let me export my board as CSV",
    position: 1,
  });
  await publish(PROJECT, { type: "card.created", cardId: epic.id, kind: "epic", epicId: null });
  return epic;
}

async function moveTicket(
  id: string,
  status: "running" | "review" | "merged" | "blocked",
  extra: { prNumber?: number; blockedReason?: string } = {},
) {
  await repository().updateTicket(id, {
    status,
    stalledIn: status === "blocked" ? "in_progress" : null,
    ...extra,
  });
  await publish(PROJECT, {
    type: "card.status",
    cardId: id,
    kind: "ticket",
    status,
    stalledIn: status === "blocked" ? "in_progress" : null,
    stage: 5,
    blockedReason: extra.blockedReason ?? null,
  });
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

describe("GitHub issues for an Epic", () => {
  it("files the request as an issue the moment it is captured", async () => {
    const epic = await newEpic();

    const number = (await repository().epicDetail(epic.id))!.issueNumber;
    expect(issue(number)).toMatchObject({
      title: "Export",
      state: "open",
      labels: ["formic: backlog"],
    });
    expect(issue(number).body).toContain("Let me export my board as CSV");
    expect(MockVcsClient.runner().labels).toContain("formic: needs a human");
  });

  it("puts the PRD in the description once it is written", async () => {
    const epic = await newEpic();
    await applyPrd(PROJECT, epic.id, PRD);

    const number = (await repository().epicDetail(epic.id))!.issueNumber;
    expect(issue(number).body).toContain("## Success criteria");
    expect(issue(number).body).toContain("- [ ] The export opens in a spreadsheet");
    expect(comments(number)).toEqual(["The PRD is written. It is in the description above."]);
    expect(issues()).toHaveLength(1);
  });

  it("files each ticket as a sub-issue, with its dependencies linked", async () => {
    const epic = await newEpic();
    await applyTickets(PROJECT, epic.id, TICKETS);

    const parent = issue((await repository().epicDetail(epic.id))!.issueNumber);
    const [t1, t2] = await repository().ticketsForEpic(epic.id);
    expect(parent.subIssues).toEqual([t1!.issueNumber, t2!.issueNumber]);
    expect(issue(t1!.issueNumber)).toMatchObject({
      title: "T-1: Export endpoint",
      labels: ["formic: to do"],
    });
    expect(issue(t1!.issueNumber).body).toContain("- [ ] It downloads");
    expect(issue(t2!.issueNumber).body).toContain(`#${t1!.issueNumber} (T-1)`);
  });
});

describe("a ticket that came in from a GitHub issue", () => {
  /**
   * What the intake leaves behind: a ticket under a standalone holder Epic,
   * with the issue it came from recorded and no issue of its own yet.
   */
  async function imported() {
    const epic = await repository().createEpic({
      projectId: PROJECT,
      title: "Export",
      rawRequest: "Let me export my board as CSV",
      position: 1,
    });
    const [ticket] = await repository().createTickets([
      {
        epicId: epic.id,
        key: "T-1",
        title: "Export endpoint",
        description: "Serve the CSV.",
        acceptanceCriteria: ["It downloads"],
        fileScope: ["src/app/api/export"],
        size: "S",
        position: 1,
        dependsOnKeys: [],
      },
    ]);
    await repository().updateTicket(ticket!.id, { sourceIssueNumber: 42 });
    MockVcsClient.seedIssue({ number: 42, title: "Add a CSV export", labels: ["formic: intake"] });
    return ticket!;
  }

  it("adopts that issue instead of filing a second one, and follows it as usual", async () => {
    const ticket = await imported();

    await moveTicket(ticket.id, "running");

    // One issue, the person's own: not #42 plus a second one describing the
    // ticket, which is what would leave their #42 open forever.
    expect(issues()).toHaveLength(1);
    expect(issue(42).labels).toEqual(["formic: in progress"]);
    expect((await repository().ticketDetail(ticket.id))!.issueNumber).toBe(42);
    expect(comments(42)).toEqual(["An agent started work on this."]);
  });
});

describe("GitHub issues for a ticket", () => {
  async function ticket() {
    const epic = await newEpic();
    await applyTickets(PROJECT, epic.id, TICKETS);
    return (await repository().ticketsForEpic(epic.id))[0]!;
  }

  it("follows the ticket across the board and closes when it merges", async () => {
    const t = await ticket();
    const number = t.issueNumber;

    await moveTicket(t.id, "running");
    expect(issue(number).labels).toEqual(["formic: in progress"]);

    await moveTicket(t.id, "review", { prNumber: 42 });
    expect(issue(number).labels).toEqual(["formic: in review"]);

    await moveTicket(t.id, "merged");
    expect(issue(number)).toMatchObject({ state: "closed", labels: ["formic: done"] });
    expect(comments(number)).toEqual([
      "An agent started work on this.",
      "Pull request opened: #42. CI and the merge are next.",
      "Merged in #42.",
    ]);
  });

  it("flags a stopped ticket for a person, with the reason", async () => {
    const t = await ticket();

    await moveTicket(t.id, "blocked", { blockedReason: "Out of scope: package.json" });

    expect(issue(t.issueNumber).labels).toEqual(["formic: in progress", "formic: needs a human"]);
    expect(comments(t.issueNumber).at(-1)).toContain("Out of scope: package.json");
  });

  it("links the pull request to the issue", async () => {
    const t = await ticket();
    const body = pullRequestBody(t, { summary: "s", detail: "d", verifiedWith: null });
    expect(body).toContain(`Closes #${t.issueNumber}.`);
  });

  it("never lets a GitHub failure stop the board", async () => {
    const client = new MockVcsClient("acme/widgets");
    client.createIssue = async () => {
      throw new Error("Resource not accessible by integration");
    };
    setVcs(client);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const epic = await newEpic();

    expect((await repository().epicDetail(epic.id))!.issueNumber).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Resource not accessible"));
  });
});
