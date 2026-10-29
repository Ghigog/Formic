import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, currentUser, activeProject } = vi.hoisted(() => ({
  repo: { meetings: vi.fn(), updateMeeting: vi.fn(), deleteMeeting: vi.fn() },
  currentUser: vi.fn(),
  activeProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));

const route = await import("./route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const PATCH = async (id: string, body: unknown) =>
  (await route.PATCH(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), ctx(id))) as Response;
const DELETE = async (id: string) => (await route.DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx(id))) as Response;

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u-1" });
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.meetings.mockResolvedValue([{ id: "m-1", projectId: "p-1", title: "Standup" }]);
});

describe("PATCH /api/calls/meetings/[id]", () => {
  it("edits the meeting", async () => {
    const res = await PATCH("m-1", { title: "Retro", guests: ["sentinel-not-real"] });
    expect(res.status).toBe(400);
    expect(repo.updateMeeting).not.toHaveBeenCalled();
    expect((await PATCH("m-1", { title: "Retro" })).status).toBe(200);
    expect(repo.updateMeeting).toHaveBeenCalledWith("m-1", { title: "Retro" });
  });

  it("is not found on another board's meeting", async () => {
    expect((await PATCH("m-9", { title: "Retro" })).status).toBe(404);
    expect(repo.updateMeeting).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/calls/meetings/[id]", () => {
  it("deletes the meeting", async () => {
    expect((await DELETE("m-1")).status).toBe(204);
    expect(repo.deleteMeeting).toHaveBeenCalledWith("m-1");
  });

  it("refuses a board the person cannot see", async () => {
    activeProject.mockResolvedValue(null);
    expect((await DELETE("m-1")).status).toBe(409);
    expect(repo.deleteMeeting).not.toHaveBeenCalled();
  });
});
