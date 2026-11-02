import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryRepository } from "@/lib/db/memory-repository";

vi.mock("server-only", () => ({}));
const { currentUser } = vi.hoisted(() => ({ currentUser: vi.fn() }));
const repo = new MemoryRepository();
vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser }));

const { POST } = await import("./route");

let n = 1;
const newUser = () => repo.upsertUser({ githubId: n++, login: `u${n}`, name: null, avatarUrl: null });
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/projects/opened", { method: "POST", body: JSON.stringify(body) }));
const project = (ownerId: string) => repo.ensureProject({ ownerId, repoFullName: null, name: "P", baseBranch: "main" });

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
});

describe("POST /api/projects/opened", () => {
  it("answers 401 when nobody is signed in", async () => {
    currentUser.mockResolvedValue(null);
    expect((await post({ projectId: "p" })).status).toBe(401);
  });

  it("answers 400 without a projectId", async () => {
    currentUser.mockResolvedValue(await newUser());
    expect((await post({})).status).toBe(400);
  });

  it("answers 404 for a missing project or one the person cannot see", async () => {
    const user = await newUser();
    const theirs = await project((await newUser()).id);
    currentUser.mockResolvedValue(user);
    expect((await post({ projectId: "nope" })).status).toBe(404);
    expect((await post({ projectId: theirs.id })).status).toBe(404);
    expect((await repo.openedAtByProject(user.id)).has(theirs.id)).toBe(false);
  });

  it("answers 200 and marks a visible project opened", async () => {
    const user = await newUser();
    const mine = await project(user.id);
    currentUser.mockResolvedValue(user);
    const res = await post({ projectId: mine.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await repo.openedAtByProject(user.id)).has(mine.id)).toBe(true);
  });
});
