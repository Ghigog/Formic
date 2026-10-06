import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { repository } from "@/lib/db";
import { resetEnvCache } from "@/lib/secrets/env";
import { MockVcsClient, resetVcs, setVcs } from "@/lib/vcs";
import type { MockIssue } from "@/lib/vcs/mock";

/**
 * GitHub issues as a way in. A person labels one `formic: intake`; the sweep
 * makes one ticket from it, drafted from what the issue says — and the issue
 * it came from becomes *the* issue the mirror tracks that ticket by, rather
 * than a second one being filed beside it.
 *
 * The Architect Agent runs detached and is not what this is about, so it is a
 * no-op here; the card it would draft is not.
 */
vi.mock("@/lib/agents/pipeline", () => ({
  launch: vi.fn(),
  repoTree: vi.fn().mockResolvedValue([]),
  startRun: vi.fn(() => ({})),
  decomposeEpic: vi.fn(),
  applyShowcase: vi.fn(),
  runProductAgent: vi.fn(),
  runArchitectDraftTicket: vi.fn(),
}));
// No demo board: the board under test is the one this imports onto.
vi.mock("@/lib/fixtures/board", () => ({ FIXTURE_CARDS: [], FIXTURE_TICKET_DETAILS: {} }));

const { importIssues } = await import("./intake");

const PROJECT = "project_default";

function issues(): MockIssue[] {
  return [...MockVcsClient.runner().issues.values()];
}

async function tickets() {
  return (await repository().boardCards(PROJECT)).filter((c) => c.kind === "ticket");
}

/** The key the intake and the webhook share, so one issue imports once. */
async function deliveryKey(number: number): Promise<string> {
  const { repoFullName } = await repository().defaultProject();
  return `issue:${repoFullName}#${number}`;
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  MockVcsClient.reset();
  resetVcs();
  setVcs(new MockVcsClient("acme/widgets"));
  vi.stubEnv("GITHUB_TOKEN", "test");
  vi.stubEnv("FORMIC_SECRET", "test");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetVcs();
});

describe("importIssues", () => {
  it("makes one ticket from a labelled issue, drafted from its text", async () => {
    MockVcsClient.seedIssue({
      number: 42,
      title: "Add a CSV export",
      body: "Every card, one row, with the column it is in.",
      labels: ["formic: intake"],
    });

    await importIssues(PROJECT);

    const [ticket] = await tickets();
    expect(ticket).toBeDefined();
    expect(await tickets()).toHaveLength(1);
    // The first line is the ticket's name; the body is what it is drafted from.
    expect(ticket!.title).toBe("Add a CSV export");
    const detail = await repository().ticketDetail(ticket!.id);
    expect(detail!.description).toContain("Every card, one row");
    expect(detail!.sourceIssueNumber).toBe(42);
  });

  it("adopts the issue it came from rather than filing a second one", async () => {
    const seeded = MockVcsClient.seedIssue({
      number: 42,
      title: "Add a CSV export",
      body: "Every card, one row.",
      labels: ["formic: intake"],
    });

    await importIssues(PROJECT);

    // Formic filed no issue of its own: #42 *is* the ticket's issue, so it is
    // the one a pull request will say `Closes #42` about, and the one that
    // closes when the ticket merges.
    expect(issues()).toHaveLength(1);
    expect(issues()[0]!.number).toBe(42);
    // And it goes on labelling it exactly as it labels any mirrored issue.
    expect(seeded.labels).toContain("formic: to do");

    const [ticket] = await tickets();
    const detail = await repository().ticketDetail(ticket!.id);
    expect(detail!.issueNumber).toBe(42);
    expect(detail!.sourceIssueNumber).toBe(42);
  });

  it("leaves the board alone for an issue nobody labelled", async () => {
    MockVcsClient.seedIssue({ number: 43, title: "Something else entirely" });
    MockVcsClient.seedIssue({
      number: 44,
      title: "Also not for Formic",
      labels: ["bug", "help wanted"],
    });

    await importIssues(PROJECT);

    expect(await tickets()).toEqual([]);
  });

  it("leaves an issue Formic itself labelled alone", async () => {
    // Its own mirror's column label: a card on some board, not a request.
    MockVcsClient.seedIssue({
      number: 45,
      title: "T-9: Export endpoint",
      labels: ["formic: in review"],
    });
    // Both: the opt-in and a column label. Still a mirror, not a request.
    MockVcsClient.seedIssue({
      number: 46,
      title: "T-10: Export button",
      labels: ["formic: intake", "formic: to do"],
    });

    await importIssues(PROJECT);

    expect(await tickets()).toEqual([]);
  });

  it("leaves an issue its own mirror already owns alone", async () => {
    MockVcsClient.seedIssue({ number: 42, title: "Add a CSV export", labels: ["formic: intake"] });
    await importIssues(PROJECT);
    expect(await tickets()).toHaveLength(1);

    // The window before the mirror's label lands on it: the number is
    // recorded, so it is still not a fresh request.
    MockVcsClient.runner().issues.get(42)!.labels = ["formic: intake"];

    await importIssues(PROJECT);

    expect(await tickets()).toHaveLength(1);
  });

  it("records the delivery, so nothing imports the same issue twice", async () => {
    MockVcsClient.seedIssue({ number: 42, title: "Add a CSV export", labels: ["formic: intake"] });

    await importIssues(PROJECT);
    await importIssues(PROJECT);
    await importIssues(PROJECT, 42);

    expect(await tickets()).toHaveLength(1);
    expect(await repository().claimDelivery(await deliveryKey(42))).toBe(false);
  });

  it("does nothing at all without a GitHub token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    resetEnvCache();
    MockVcsClient.seedIssue({ number: 42, title: "Add a CSV export", labels: ["formic: intake"] });

    await importIssues(PROJECT);

    expect(await tickets()).toEqual([]);
  });

  it("reads open issues only", async () => {
    MockVcsClient.seedIssue({
      number: 42,
      title: "Already finished somewhere else",
      labels: ["formic: intake"],
      state: "closed",
    });

    await importIssues(PROJECT);

    expect(await tickets()).toEqual([]);
  });

  it("does not take the ticket away when the label comes off", async () => {
    MockVcsClient.seedIssue({ number: 42, title: "Add a CSV export", labels: ["formic: intake"] });
    await importIssues(PROJECT);
    expect(await tickets()).toHaveLength(1);

    // The label is a door, not a leash: it got the ticket in, and it is not a
    // subscription that keeps it there.
    MockVcsClient.runner().issues.get(42)!.labels = [];

    await importIssues(PROJECT);

    expect(await tickets()).toHaveLength(1);
  });

  it("says once that it cannot read the repository, and leaves the board working", async () => {
    const client = new MockVcsClient("acme/widgets");
    client.issues = async () => {
      throw new Error("Resource not accessible by integration");
    };
    setVcs(client);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await importIssues(PROJECT);
    await importIssues(PROJECT);

    expect(await tickets()).toEqual([]);
    // Once, not once per sweep: the board is meant to say nothing about a
    // repository it cannot read, not fill its logs.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Resource not accessible"));
    warn.mockRestore();
  });
});
