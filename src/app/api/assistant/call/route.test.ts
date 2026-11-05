import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, currentUser, activeProject, launch, answer, limited } = vi.hoisted(() => ({
  repo: { assistantMessages: vi.fn(), addAssistantMessage: vi.fn(), boardCards: vi.fn(), meetings: vi.fn() },
  currentUser: vi.fn(),
  activeProject: vi.fn(),
  launch: vi.fn(),
  answer: vi.fn(),
  limited: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));
vi.mock("@/lib/agents/pipeline", () => ({ launch }));
vi.mock("@/lib/assistant/turn", () => ({ answer }));
vi.mock("@/lib/rate-limit", () => ({ limited, RUN: "run" }));

const route = await import("./route");
const post = async (body?: unknown) =>
  (await route.POST(
    new Request("http://localhost/api/assistant/call", { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  )) as Response;

const QUESTION = "Question: Which scope?\nThe Coder is waiting for your answer.\n\nWhich scope?";

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u-1" });
  activeProject.mockResolvedValue({ id: "p-1" });
  limited.mockReturnValue(null);
  repo.assistantMessages.mockResolvedValue([]);
  repo.addAssistantMessage.mockResolvedValue({ id: "m-1" });
  repo.boardCards.mockResolvedValue([]);
});

describe("POST /api/assistant/call", () => {
  it("needs a signed-in person", async () => {
    currentUser.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(launch).not.toHaveBeenCalled();
  });

  it("opens with a greeting when nothing waits", async () => {
    expect((await post()).status).toBe(200);
    await launch.mock.calls[0]![0]();
    expect(answer).toHaveBeenCalledWith("p-1", "m-1", expect.stringContaining("Greet them"));
  });

  it("opens with the questions waiting on the person", async () => {
    repo.boardCards.mockResolvedValue([
      { key: "T-133", title: "A", blockedReason: QUESTION },
      { key: "T-134", title: "B", blockedReason: QUESTION },
      { key: "T-135", title: "C", blockedReason: null },
    ]);
    await post();
    await launch.mock.calls[0]![0]();
    const prompt = answer.mock.calls[0]![2] as string;
    expect(prompt).toContain("Two questions are waiting");
    expect(prompt).toContain("T-133");
    expect(prompt).not.toContain("T-135");
  });

  it("does not interrupt an answer in progress", async () => {
    repo.assistantMessages.mockResolvedValue([{ status: "pending" }]);
    await post();
    expect(repo.addAssistantMessage).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("queues a meeting: the PM, each guest in turn, then the PM", async () => {
    repo.meetings.mockResolvedValue([
      { id: "mt-1", title: "Sprint planning", agenda: "Scope\nRisks", guests: ["assistant", "coder"] },
    ]);
    repo.addAssistantMessage.mockImplementation(async (m: { speaker?: string }) => ({ id: `m-${m.speaker ?? "user"}` }));
    expect((await post({ meetingId: "mt-1" })).status).toBe(200);
    const added = repo.addAssistantMessage.mock.calls.map((c) => c[0]);
    expect(added[0]).toMatchObject({ role: "user", content: expect.stringContaining("Sprint planning") });
    expect(added.slice(1).map((m) => m.speaker)).toEqual(["assistant", "coder", "assistant"]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("refuses a meeting that is not on the board", async () => {
    repo.meetings.mockResolvedValue([]);
    expect((await post({ meetingId: "nope" })).status).toBe(404);
  });
});
