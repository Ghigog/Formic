import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, stopAll } = vi.hoisted(() => ({
  activeProject: vi.fn(),
  stopAll: vi.fn(),
}));

vi.mock("@/lib/budget/controller", () => ({ stopAll }));
vi.mock("@/lib/auth/credentials", () => ({
  credentialsForProject: vi.fn().mockResolvedValue({ e2bKey: "key" }),
}));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");

beforeEach(() => vi.clearAllMocks());

describe("POST /api/runs/stop", () => {
  it("stops every run on the active project", async () => {
    activeProject.mockResolvedValue({ id: "p-1" });
    stopAll.mockResolvedValue(3);
    const res = await POST();
    expect(await res.json()).toEqual({ stopped: 3 });
    expect(stopAll).toHaveBeenCalledWith("p-1", undefined, "key");
  });

  it("409s with no project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await POST()).status).toBe(409);
    expect(stopAll).not.toHaveBeenCalled();
  });
});
