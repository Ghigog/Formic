import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const { repository } = await import("@/lib/db");
const { currentUser } = await import("@/lib/auth/user");
const { GET, PATCH } = await import("./route");
const { setVcs, resetVcs } = await import("@/lib/vcs");
import type { VcsClient } from "@/lib/vcs/types";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }), ctx(id));

async function board() {
  const user = (await currentUser())!;
  return repository().ensureProject({ ownerId: user.id, repoFullName: "acme/widgets", baseBranch: "main" });
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  resetVcs();
});

describe("GET /api/projects/[id]", () => {
  it("reports the base branch's commits and that the threshold of 100 is met", async () => {
    const p = await board();
    setVcs({ countCommits: async () => 150 } as unknown as VcsClient);
    const res = await GET(new Request("http://localhost"), ctx(p.id));
    expect(await res.json()).toEqual({
      id: p.id,
      unlockAllSentinels: false,
      baseBranchCommits: 150,
      established: true,
      establishedThreshold: 100,
    });
  });

  it("does not count a short history as established", async () => {
    const p = await board();
    setVcs({ countCommits: async () => 99 } as unknown as VcsClient);
    const body = (await (await GET(new Request("http://localhost"), ctx(p.id))).json()) as { established: boolean };
    expect(body.established).toBe(false);
  });

  it("is 404 for a project that does not exist", async () => {
    expect((await GET(new Request("http://localhost"), ctx("nope"))).status).toBe(404);
  });
});

describe("PATCH /api/projects/[id]", () => {
  it("saves unlockAllSentinels", async () => {
    const p = await board();
    setVcs({ countCommits: async () => 3 } as unknown as VcsClient);
    const res = await patch(p.id, { unlockAllSentinels: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unlockAllSentinels: boolean }).unlockAllSentinels).toBe(true);
    expect((await repository().projectById(p.id))?.unlockAllSentinels).toBe(true);
  });

  it("refuses a body that is not a boolean", async () => {
    const p = await board();
    expect((await patch(p.id, { unlockAllSentinels: "yes" })).status).toBe(400);
  });

  it("refuses a project that is not yours", async () => {
    const other = await repository().ensureProject({ ownerId: "someone-else", repoFullName: "x/y", baseBranch: "main" });
    expect((await patch(other.id, { unlockAllSentinels: true })).status).toBe(403);
  });
});
