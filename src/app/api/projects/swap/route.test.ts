import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const { repository } = await import("@/lib/db");
const { currentUser } = await import("@/lib/auth/user");
const { openExampleProject } = await import("@/lib/board/example");
const { POST: swap } = await import("./route");
const { POST: opened } = await import("../opened/route");
const { GET } = await import("../route");
const { NextRequest } = await import("next/server");

const post = (handler: typeof swap, body: unknown) =>
  handler(new NextRequest("http://localhost/api/projects/swap", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("POST /api/projects/swap", () => {
  it("returns the board's data and sets the cookie without marking it opened", async () => {
    const repo = repository();
    const user = (await currentUser())!;
    const project = await repo.ensureProject({ ownerId: user.id, repoFullName: null, name: "Other", baseBranch: "main" });
    const before = await repo.openedAtByProject(user.id);

    const res = await post(swap, { projectId: project.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { board: { projectName: string; initialCards: unknown[] } };
    expect(body.board.projectName).toBe("Other");
    expect(Array.isArray(body.board.initialCards)).toBe(true);
    expect(res.headers.get("Set-Cookie")).toContain(encodeURIComponent(project.id));
    expect(await repo.openedAtByProject(user.id)).toEqual(before);
  });

  it("answers 404 without a cookie for an unknown board or the example board", async () => {
    const user = (await currentUser())!;
    const example = await openExampleProject(user.id);
    for (const projectId of ["nope", example.id]) {
      const res = await post(swap, { projectId });
      expect(res.status).toBe(404);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
  });
});

describe("POST /api/projects/opened", () => {
  it("moves the board to the top of the list", async () => {
    const repo = repository();
    const user = (await currentUser())!;
    const a = await repo.ensureProject({ ownerId: user.id, repoFullName: null, name: "A", baseBranch: "main" });
    await repo.markOpened(user.id, a.id);
    const b = await repo.ensureProject({ ownerId: user.id, repoFullName: null, name: "B", baseBranch: "main" });
    await repo.markOpened(user.id, b.id);

    await post(swap, { projectId: a.id });
    expect((await post(opened, { projectId: a.id })).status).toBe(200);
    const list = (await (await GET()).json()) as { projects: Array<{ id: string }> };
    expect(list.projects[0]?.id).toBe(a.id);
  });
});
