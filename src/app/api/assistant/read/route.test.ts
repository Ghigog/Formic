import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, currentUser, activeProject } = vi.hoisted(() => ({
  repo: { markPmRead: vi.fn() },
  currentUser: vi.fn(),
  activeProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));

const { POST } = await import("./route");
const post = async () => (await POST()) as Response;

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u1" });
  activeProject.mockResolvedValue({ id: "p1" });
});

describe("POST /api/assistant/read", () => {
  it("marks the PM chat read for the person on the active board", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(repo.markPmRead).toHaveBeenCalledWith("u1", "p1", expect.any(Date));
    expect(typeof (await res.json()).readAt).toBe("string");
  });

  it("refuses when signed out, and without a board", async () => {
    currentUser.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    currentUser.mockResolvedValue({ id: "u1" });
    activeProject.mockResolvedValue(null);
    expect((await post()).status).toBe(409);
    expect(repo.markPmRead).not.toHaveBeenCalled();
  });
});
