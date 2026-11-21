import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryRepository } from "@/lib/db/memory-repository";

vi.mock("server-only", () => ({}));
const repo = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));

const { branchHolder, lockBranch, lockForRun, pmHolder, runHolder, unlockBranch } = await import("./branch-lock");

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("the branch lock", () => {
  it("holds one writer per branch of a board", async () => {
    expect(await lockBranch("p", "t-1", pmHolder("j"), 60_000)).toBe(true);
    expect(await lockBranch("p", "t-1", runHolder("k"), 60_000)).toBe(false);
    // Another board's branch of the same name is its own.
    expect(await lockBranch("q", "t-1", runHolder("k"), 60_000)).toBe(true);
    await unlockBranch("p", "t-1", pmHolder("j"));
    expect(await branchHolder("p", "t-1")).toBeNull();
  });

  it("expires, so a crash never wedges a branch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await lockBranch("p", "b", pmHolder("j"), 1_000);
      vi.setSystemTime(Date.now() + 1_001);
      expect(await lockBranch("p", "b", runHolder("k"), 1_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes a ticket run wait while the PM moves its branch, then take it", async () => {
    await lockBranch("p", "b", pmHolder("j"), 60_000);
    let waited = 0;
    const took = await lockForRun("p", "b", "run-1", 60_000, {
      sleep: async () => {
        waited++;
        await unlockBranch("p", "b", pmHolder("j"));
      },
    });
    expect(took).toBe(true);
    expect(waited).toBe(1);
    expect(await branchHolder("p", "b")).toBe(runHolder("run-1"));
  });

  it("gives up waiting on the PM rather than fail the run", async () => {
    await lockBranch("p", "b", pmHolder("j"), 60_000);
    expect(await lockForRun("p", "b", "run-1", 60_000, { waitMs: 0, sleep: async () => undefined })).toBe(false);
  });

  it("lets a retried run take over from the run it replaces", async () => {
    await lockBranch("p", "b", runHolder("old"), 60_000);
    expect(await lockForRun("p", "b", "new", 60_000, { waitMs: 0 })).toBe(true);
    expect(await branchHolder("p", "b")).toBe(runHolder("new"));
  });
});
