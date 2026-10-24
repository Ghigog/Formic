import { beforeEach, describe, expect, it, vi } from "vitest";

/** Stands in for Next's request scope; see src/lib/auth/isolation.test.ts. */
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

/** Setup would open a pull request; the route only has to start it. */
const launch = vi.fn();
vi.mock("@/lib/agents/pipeline", () => ({ launch }));

const { repository } = await import("@/lib/db");
const { currentUser } = await import("@/lib/auth/user");
const { GET, POST } = await import("./route");
const { dailyBudget, utcDay } = await import("@/lib/usage/governor");
const { NextRequest } = await import("next/server");

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/projects", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  launch.mockClear();
  vi.unstubAllEnvs();
});

describe("GET /api/projects", () => {
  it("names each project's latest finished assistant message, or null", async () => {
    const repo = repository();
    const user = (await currentUser())!;
    const project = await repo.ensureProject({ ownerId: user.id, repoFullName: "acme/widgets", baseBranch: "main" });
    const done = await repo.addAssistantMessage({ projectId: project.id, role: "assistant", content: "hi", status: "done" });
    await repo.addAssistantMessage({ projectId: project.id, role: "assistant", content: "", status: "pending" });

    const body = (await (await GET()).json()) as {
      projects: Array<{ id: string; lastAssistantMessage: { id: string } | null }>;
    };
    expect(body.projects.find((p) => p.id === project.id)!.lastAssistantMessage?.id).toBe(done.id);
  });
});

describe("GET /api/projects notifications", () => {
  it("names the latest event of each kind, leaving out kinds switched off", async () => {
    const repo = repository();
    const user = (await currentUser())!;
    const project = await repo.ensureProject({ ownerId: user.id, repoFullName: "acme/gadgets", baseBranch: "main" });
    const status = (cardId: string, status: string) => ({
      type: "card.status", cardId, kind: "ticket", status, stalledIn: null, stage: 0, blockedReason: null,
    });
    await repo.appendEvent(project.id, "card.status", status("c1", "blocked"));
    const moved = await repo.appendEvent(project.id, "card.status", status("c1", "in_review"));
    const body = (await (await GET()).json()) as {
      projects: Array<{ id: string; notifications: Record<string, { seq: number }> }>;
    };
    const mine = body.projects.find((p) => p.id === project.id)!;
    expect(mine.notifications.ticketMoved?.seq).toBe(moved);
    expect(mine.notifications.needsAttention).toBeDefined();
  });
});

describe("GET /api/projects order", () => {
  it("lists the boards most recently opened first, then the unopened in creation order", async () => {
    const repo = repository();
    const user = (await currentUser())!;
    const ids: string[] = [];
    for (const name of ["a", "b", "c", "d"]) {
      ids.push((await repo.ensureProject({ ownerId: user.id, repoFullName: `acme/${name}`, baseBranch: "main" })).id);
    }
    await repo.markOpened(user.id, ids[2]!);
    await new Promise((r) => setTimeout(r, 5));
    await repo.markOpened(user.id, ids[1]!);

    const body = (await (await GET()).json()) as { projects: Array<{ id: string; lastOpenedAt: string | null }> };
    const mine = body.projects.filter((p) => ids.includes(p.id));
    expect(mine.map((p) => p.id)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    expect(mine[0]!.lastOpenedAt).toEqual(expect.any(String));
    expect(mine[3]!.lastOpenedAt).toBeNull();
    // Boards never opened, the default one included, come after every opened board.
    expect(body.projects.slice(0, 2).map((p) => p.id)).toEqual([ids[1], ids[2]]);
  });
});

describe("POST /api/projects", () => {
  it("records the board as opened, new or switched to", async () => {
    const user = (await currentUser())!;
    const { project } = (await (await post({ repoFullName: "acme/widgets" })).json()) as { project: { id: string } };
    const first = (await repository().openedAtByProject(user.id)).get(project.id);
    expect(first).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 5));
    await post({ projectId: project.id });
    expect((await repository().openedAtByProject(user.id)).get(project.id)!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it("creates the project for a repository and responds with it", async () => {
    const res = await post({ repoFullName: "acme/widgets" });
    expect(res.status).toBe(200);
    const { project } = (await res.json()) as { project: { id: string; repoFullName: string } };
    expect(project.repoFullName).toBe("acme/widgets");
    expect(res.headers.get("set-cookie")).toContain(encodeURIComponent(project.id));
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("reuses the project on a second request without setting it up again", async () => {
    const first = (await (await post({ repoFullName: "acme/widgets" })).json()) as { project: { id: string } };
    const second = (await (await post({ repoFullName: "acme/widgets" })).json()) as { project: { id: string } };
    expect(second.project.id).toBe(first.project.id);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("refuses a body with neither a projectId nor a repoFullName", async () => {
    expect((await post({})).status).toBe(400);
  });

  it("refuses a repository name that is not owner/repo", async () => {
    expect((await post({ repoFullName: "not a repo" })).status).toBe(400);
  });

  it("answers 404 for a project that does not exist", async () => {
    expect((await post({ projectId: "missing" })).status).toBe(404);
  });

  it("near the host allowance, still switches to an existing board but opens no new one", async () => {
    const first = (await (await post({ repoFullName: "acme/widgets" })).json()) as { project: { id: string } };
    vi.stubEnv("FORMIC_USAGE_LIMITS", "on");
    const today = utcDay(Date.now());
    await repository().addPlatformUsage(
      today,
      { requests: dailyBudget().requests * 0.9, busyMs: 0, cpuMs: 0 },
      today,
    );

    expect((await post({ projectId: first.project.id })).status).toBe(200);
    expect((await post({ repoFullName: "acme/widgets" })).status).toBe(200);
    expect((await post({ repoFullName: "acme/gadgets" })).status).toBe(503);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
