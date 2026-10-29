import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, currentUser, activeProject, ask } = vi.hoisted(() => ({
  repo: { meetings: vi.fn(), callMessages: vi.fn() },
  currentUser: vi.fn(),
  activeProject: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));
vi.mock("@/lib/calls/turn", () => ({ ask }));
vi.mock("@/lib/rate-limit", () => ({ limited: () => null, RUN: {} }));

const route = await import("./route");
const context = (id: string) => ({ params: Promise.resolve({ meetingId: id }) });
const POST = async (body: unknown, id = "m-1") =>
  (await route.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), context(id))) as Response;
const GET = async (id = "m-1") => (await route.GET(new Request("http://localhost/x"), context(id))) as Response;

const meeting = { id: "m-1", projectId: "p-1", agenda: "Plan" };

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u-1" });
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.meetings.mockResolvedValue([meeting]);
  repo.callMessages.mockResolvedValue([{ id: "c-1", content: "hi" }]);
});

describe("/api/calls/[meetingId]/messages", () => {
  it("GET returns the meeting and its earlier messages", async () => {
    const body = await (await GET()).json();
    expect(body.meeting.agenda).toBe("Plan");
    expect(body.messages).toHaveLength(1);
    expect(repo.callMessages).toHaveBeenCalledWith("p-1", "m-1");
  });

  it("GET is a 404 for a meeting not on this board", async () => {
    expect((await GET("other")).status).toBe(404);
  });

  it("POST sends the text to the call and returns the state", async () => {
    const res = await POST({ text: " hello " });
    expect(res.status).toBe(200);
    expect(ask).toHaveBeenCalledWith("p-1", "m-1", "hello");
  });

  it("POST rejects empty text", async () => {
    expect((await POST({ text: " " })).status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
  });
});
