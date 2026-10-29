import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, currentUser, activeProject } = vi.hoisted(() => ({
  repo: { meetings: vi.fn(), createMeeting: vi.fn() },
  currentUser: vi.fn(),
  activeProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));

const route = await import("./route");

const POST = async (body: unknown) =>
  (await route.POST(new Request("http://localhost/api/calls/meetings", { method: "POST", body: JSON.stringify(body) }))) as Response;
const GET = async () => (await route.GET()) as Response;

const valid = { title: "Standup", startsAt: "2026-11-10T09:00:00.000Z", guests: ["assistant"] };

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u-1" });
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.createMeeting.mockImplementation(async (input: object) => ({ id: "m-1", ...input }));
  repo.meetings.mockResolvedValue([]);
});

describe("POST /api/calls/meetings", () => {
  it("stores a valid meeting and answers 201", async () => {
    const res = await POST(valid);
    expect(res.status).toBe(201);
    expect(repo.createMeeting).toHaveBeenCalledWith({
      projectId: "p-1",
      title: "Standup",
      startsAt: new Date(valid.startsAt),
      guests: ["assistant"],
    });
  });

  it("rejects an unknown guest and stores nothing", async () => {
    const res = await POST({ ...valid, guests: ["assistant", "nobody"] });
    expect(res.status).toBe(400);
    expect(repo.createMeeting).not.toHaveBeenCalled();
  });

  it("rejects a body without a title", async () => {
    expect((await POST({ startsAt: valid.startsAt })).status).toBe(400);
  });

  it("asks to sign in when there is no user", async () => {
    currentUser.mockResolvedValue(null);
    expect((await POST(valid)).status).toBe(401);
    expect(repo.createMeeting).not.toHaveBeenCalled();
  });
});

describe("GET /api/calls/meetings", () => {
  it("lists the active board's meetings", async () => {
    repo.meetings.mockResolvedValue([{ id: "m-1" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(repo.meetings).toHaveBeenCalledWith("p-1");
    expect(await res.json()).toEqual({ meetings: [{ id: "m-1" }] });
  });

  it("refuses a board the person cannot see", async () => {
    activeProject.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(409);
    expect(repo.meetings).not.toHaveBeenCalled();
  });
});
