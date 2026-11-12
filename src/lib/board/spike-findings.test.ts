import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { MockVcsClient, resetVcs, setVcs } = await import("@/lib/vcs");
const { resetEnvCache } = await import("@/lib/secrets/env");
const { spikeFindings } = await import("./spike-findings");

const PROJECT = { id: "p", repoFullName: "acme/widgets", baseBranch: "main" } as Parameters<typeof spikeFindings>[0];
const client = new MockVcsClient("acme/widgets");
const TICKET = { key: "EPIC-4-T2", prUrl: "https://github.com/acme/widgets/pull/9" };

beforeEach(() => {
  MockVcsClient.reset();
  resetVcs();
  setVcs(client);
  vi.stubEnv("GITHUB_TOKEN", "test");
  resetEnvCache();
});

describe("spikeFindings", () => {
  it("reads the findings file on the base branch in full", async () => {
    await client.commitFile("main", "docs/spikes/epic-4-t2-capture-bugs.md", "# Question\n\nWhy?", "m");

    expect(await spikeFindings(PROJECT, TICKET)).toEqual({
      found: true,
      path: "docs/spikes/epic-4-t2-capture-bugs.md",
      markdown: "# Question\n\nWhy?",
    });
  });

  it("points at the pull request when the file is not on the branch", async () => {
    await client.commitFile("spike-branch", "docs/spikes/epic-4-t2-capture-bugs.md", "x", "m");

    expect(await spikeFindings(PROJECT, TICKET)).toEqual({ found: false, prUrl: TICKET.prUrl });
  });

  it("picks the file of its own key when two spikes are on the branch", async () => {
    await client.commitFile("main", "docs/spikes/epic-4-t20-other.md", "other", "m");
    await client.commitFile("main", "docs/spikes/epic-4-t1-first.md", "first", "m");
    await client.commitFile("main", "docs/spikes/epic-4-t2-capture-bugs.md", "mine", "m");

    expect(await spikeFindings(PROJECT, TICKET)).toMatchObject({ found: true, markdown: "mine" });
  });
});
