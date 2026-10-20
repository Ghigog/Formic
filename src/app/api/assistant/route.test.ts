import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, currentUser, activeProject, launch, answer, cancelPending, collectCliRuns, limited } = vi.hoisted(() => ({
  repo: {
    assistantAgent: vi.fn(),
    assistantMessages: vi.fn(),
    addAssistantMessage: vi.fn(),
    clearAssistant: vi.fn(),
  },
  currentUser: vi.fn(),
  activeProject: vi.fn(),
  launch: vi.fn(),
  answer: vi.fn(),
  cancelPending: vi.fn(),
  collectCliRuns: vi.fn(),
  limited: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));
vi.mock("@/lib/agents/pipeline", () => ({ launch }));
vi.mock("@/lib/assistant/turn", () => ({ answer, cancelPending }));
vi.mock("@/lib/runner/runner", () => ({ collectCliRuns }));
vi.mock("@/lib/rate-limit", () => ({ limited, RUN: "run" }));

const route = await import("./route");

// The handlers' inferred type admits undefined; they always respond.
const GET = async () => (await route.GET()) as Response;
const PATCH = async () => (await route.PATCH()) as Response;
const DELETE = async () => (await route.DELETE()) as Response;

async function ask(body: unknown) {
  return (await route.POST(new Request("http://localhost/api/assistant", { method: "POST", body: JSON.stringify(body) }))) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u-1" });
  activeProject.mockResolvedValue({ id: "p-1" });
  limited.mockReturnValue(null);
  collectCliRuns.mockResolvedValue(undefined);
  repo.assistantAgent.mockResolvedValue("preset-1");
  repo.assistantMessages.mockResolvedValue([]);
  repo.addAssistantMessage.mockResolvedValue({ id: "m-2" });
});

describe("GET /api/assistant", () => {
  it("returns the agent and the conversation", async () => {
    repo.assistantMessages.mockResolvedValue([{ id: "m-1" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ presetId: "preset-1", messages: [{ id: "m-1" }] });
  });

  it("still answers when checking the runs fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    collectCliRuns.mockRejectedValue(new Error("down"));
    expect((await GET()).status).toBe(200);
  });

  it("asks to sign in when there is no user", async () => {
    currentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("refuses when there is no active project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await GET()).status).toBe(409);
  });
});

describe("POST /api/assistant", () => {
  it("stores the question, adds a pending reply and launches the answer", async () => {
    const res = await ask({ text: "  hello  " });
    expect(res.status).toBe(200);
    expect(repo.addAssistantMessage).toHaveBeenNthCalledWith(1, { projectId: "p-1", role: "user", content: "hello" });
    expect(repo.addAssistantMessage).toHaveBeenNthCalledWith(2, {
      projectId: "p-1",
      role: "assistant",
      content: "",
      status: "pending",
    });
    expect(launch).toHaveBeenCalledOnce();
    launch.mock.calls[0]?.[0]();
    expect(answer).toHaveBeenCalledWith("p-1", "m-2");
  });

  it("returns the rate limit response", async () => {
    limited.mockReturnValue(Response.json({}, { status: 429 }));
    expect((await ask({ text: "hi" })).status).toBe(429);
    expect(repo.addAssistantMessage).not.toHaveBeenCalled();
  });

  it("asks to sign in when there is no user", async () => {
    currentUser.mockResolvedValue(null);
    expect((await ask({ text: "hi" })).status).toBe(401);
  });

  it.each([[{ text: "   " }], [{}], [null]])("rejects an empty question %j", async (body) => {
    expect((await ask(body)).status).toBe(400);
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects a question while the last is still pending", async () => {
    repo.assistantMessages.mockResolvedValue([{ id: "m-1", status: "pending" }]);
    expect((await ask({ text: "hi" })).status).toBe(409);
    expect(repo.addAssistantMessage).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/assistant", () => {
  it("cancels the pending answer", async () => {
    const res = await PATCH();
    expect(res.status).toBe(200);
    expect(cancelPending).toHaveBeenCalledWith("p-1");
  });

  it("asks to sign in when there is no user", async () => {
    currentUser.mockResolvedValue(null);
    expect((await PATCH()).status).toBe(401);
    expect(cancelPending).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/assistant", () => {
  it("clears the conversation", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(repo.clearAssistant).toHaveBeenCalledWith("p-1");
  });

  it("refuses when there is no active project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await DELETE()).status).toBe(409);
    expect(repo.clearAssistant).not.toHaveBeenCalled();
  });
});
