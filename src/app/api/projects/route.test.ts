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
const { NextRequest } = await import("next/server");

const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/projects", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  launch.mockClear();
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

describe("POST /api/projects", () => {
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
});
