import { beforeEach, describe, expect, it } from "vitest";

import { MockVcsClient } from "./mock";
import { BranchMovedError } from "./types";

/** The mock's branch moves and merges, which every other test leans on. */

beforeEach(() => MockVcsClient.reset());

const client = () => new MockVcsClient("acme/widgets");

describe("moveBranch", () => {
  it("creates a branch that is not there", async () => {
    await client().moveBranch("feat/x", "s1");
    expect(await client().branchHead("feat/x")).toBe("s1");
  });

  it("says the branch moved where a test says it gained a commit", async () => {
    await client().moveBranch("feat/x", "tip");
    (globalThis as unknown as { __formicMockRepo: { moved: Set<string> } }).__formicMockRepo.moved.add("feat/x");

    const err = await client().moveBranch("feat/x", "s1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BranchMovedError);
    expect(err).toMatchObject({ branch: "feat/x", head: "tip" });
  });
});

describe("mergeOntoBranch", () => {
  it("returns a commit holding both changes and moves the branch to it", async () => {
    const g = globalThis as unknown as { __formicMockRepo: { commits: Map<string, { files: string[]; message: string }> } };
    await client().moveBranch("feat/x", "tip");
    g.__formicMockRepo.commits.set("tip", { files: ["a.ts"], message: "someone's" });
    g.__formicMockRepo.commits.set("agent", { files: ["b.ts"], message: "agent's" });

    const out = await client().mergeOntoBranch("feat/x", "agent");

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(g.__formicMockRepo.commits.get(out.sha)!.files.sort()).toEqual(["a.ts", "b.ts"]);
    expect(await client().branchHead("feat/x")).toBe(out.sha);
  });

  it("reports a conflict and leaves the branch where it was", async () => {
    await client().moveBranch("feat/x", "tip");
    (globalThis as unknown as { __formicMockRepo: { conflicts: Set<string> } }).__formicMockRepo.conflicts.add("feat/x<-agent");

    expect(await client().mergeOntoBranch("feat/x", "agent")).toMatchObject({ ok: false, conflict: true });
    expect(await client().branchHead("feat/x")).toBe("tip");
  });
});
