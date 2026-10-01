import { describe, expect, it, vi } from "vitest";
import type { VcsClient } from "@/lib/vcs/types";
import { gatherEvidence } from "./gather";

function client(over: Partial<VcsClient> = {}): VcsClient {
  return {
    branchHead: vi.fn(async () => "abc1234"),
    checksFor: vi.fn(async () => [
      { id: 7, name: "test", status: "completed" as const, conclusion: "failure" as const, detailsUrl: null },
    ]),
    checkLog: vi.fn(async () => ({ name: "test", summary: "boom", annotations: [] })),
    branchRuns: vi.fn(async () => []),
    readFile: vi.fn(async (path: string) =>
      path === "package.json" ? JSON.stringify({ dependencies: { a: "1" } }) : null,
    ),
    ...over,
  } as unknown as VcsClient;
}

describe("gatherEvidence", () => {
  it("gathers nothing for a role that needs nothing", async () => {
    const c = client();
    expect(await gatherEvidence(c, "main", [], undefined)).toEqual([]);
    expect(c.branchHead).not.toHaveBeenCalled();
  });

  it("reads the base branch's checks and the failed ones' logs", async () => {
    const c = client();
    const [text] = await gatherEvidence(c, "main", [], ["ci"]);
    expect(c.checksFor).toHaveBeenCalledWith("abc1234");
    expect(c.checkLog).toHaveBeenCalledWith(7);
    expect(text).toContain('Failed check "test":\nboom');
  });

  it("reads the lockfile only when it is one it can parse", async () => {
    const c = client();
    await gatherEvidence(c, "main", ["package.json", "yarn.lock"], ["deps"]);
    expect(c.readFile).toHaveBeenCalledTimes(1);
    await gatherEvidence(c, "main", ["package.json", "package-lock.json"], ["deps"]);
    expect(c.readFile).toHaveBeenCalledWith("package-lock.json", "main");
  });

  it("says what GitHub would not give, instead of failing the audit", async () => {
    const c = client({ branchRuns: vi.fn(async () => Promise.reject(new Error("Resource not accessible"))) });
    expect(await gatherEvidence(c, "main", [], ["ci"])).toEqual([
      "CI results could not be read from GitHub: Resource not accessible",
    ]);
  });
});
