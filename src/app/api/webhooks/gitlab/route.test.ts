import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A GitLab project's job events: only Formic's job finishing does anything,
 * and only with the project's own token.
 */

const { collectCliRuns } = vi.hoisted(() => ({ collectCliRuns: vi.fn(async () => undefined) }));
vi.mock("@/lib/runner/runner", () => ({ collectCliRuns }));
vi.mock("@/lib/agents/pipeline", () => ({ launch: (fn: () => Promise<void>) => void fn() }));

const { POST } = await import("./route");
const { repository } = await import("@/lib/db");
const { gitlabHookToken, verifyGitlabHook } = await import("@/lib/runner/gitlab-hook");

function delivery(body: Record<string, unknown>, token: string | null) {
  return POST(
    new Request("http://localhost/api/webhooks/gitlab", {
      method: "POST",
      headers: token ? { "x-gitlab-token": token } : {},
      body: JSON.stringify(body),
    }) as never,
  );
}

const job = (over: Record<string, unknown> = {}) => ({
  object_kind: "build",
  build_name: "formic-agent",
  build_status: "success",
  project: { path_with_namespace: "acme/widgets" },
  ...over,
});

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("FORMIC_SECRET", "s".repeat(32));
  collectCliRuns.mockClear();
});

describe("the GitLab webhook token", () => {
  it("is the project's own, and only it passes", () => {
    const token = gitlabHookToken("acme/widgets");
    expect(token).not.toBe(gitlabHookToken("acme/other"));
    expect(verifyGitlabHook("acme/widgets", token)).toBe(true);
    expect(verifyGitlabHook("acme/other", token)).toBe(false);
    expect(verifyGitlabHook("acme/widgets", null)).toBe(false);
  });
});

describe("POST /api/webhooks/gitlab", () => {
  it("refuses a delivery without the project's token", async () => {
    expect((await delivery(job(), gitlabHookToken("acme/other"))).status).toBe(401);
    expect((await delivery(job(), null)).status).toBe(401);
    expect(collectCliRuns).not.toHaveBeenCalled();
  });

  it("looks at once at the runs of every board on the project when Formic's job finishes", async () => {
    const a = await repository().ensureProject({ ownerId: null, repoFullName: "gitlab:acme/widgets", baseBranch: "main" });

    const res = await delivery(job(), gitlabHookToken("acme/widgets"));

    expect(res.status).toBe(202);
    expect(collectCliRuns).toHaveBeenCalledWith(a.id, { now: true });
  });

  it.each([
    ["another job", { build_name: "test" }],
    ["a job still running", { build_status: "running" }],
    ["another event", { object_kind: "pipeline" }],
  ])("ignores %s", async (_name, over) => {
    await repository().ensureProject({ ownerId: null, repoFullName: "gitlab:acme/widgets", baseBranch: "main" });
    const res = await delivery(job(over), gitlabHookToken("acme/widgets"));
    expect(res.status).toBe(202);
    expect(collectCliRuns).not.toHaveBeenCalled();
  });
});
