import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, currentUser, activeProject, applyAction, checkAction } = vi.hoisted(() => ({
  repo: {
    assistantMessage: vi.fn(),
    updateAssistantMessage: vi.fn(),
    addAssistantMessage: vi.fn(),
    assistantAgent: vi.fn(),
    assistantMessages: vi.fn(),
  },
  currentUser: vi.fn(),
  activeProject: vi.fn(),
  applyAction: vi.fn(),
  checkAction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));
vi.mock("@/lib/assistant/actions", () => ({ applyAction, checkAction }));

const { POST } = await import("./route");

const action = { type: "create_ticket" };

function decide(body: unknown) {
  return POST(new Request("http://localhost/api/assistant/proposals", { method: "POST", body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u-1" });
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.assistantMessage.mockResolvedValue({ id: "m-1", projectId: "p-1", proposals: [{ state: "proposed", action }] });
  repo.assistantAgent.mockResolvedValue(null);
  repo.assistantMessages.mockResolvedValue([]);
  checkAction.mockReturnValue({ ok: true, action });
  applyAction.mockResolvedValue("Done.");
});

describe("POST /api/assistant/proposals", () => {
  it("dismisses a proposal without applying it", async () => {
    const res = await decide({ messageId: "m-1", index: 0, decision: "dismiss" });
    expect(res.status).toBe(200);
    expect(applyAction).not.toHaveBeenCalled();
    expect(repo.updateAssistantMessage).toHaveBeenCalledWith("m-1", {
      proposals: [{ state: "dismissed", action }],
    });
  });

  it("applies a proposal and posts the outcome", async () => {
    const res = await decide({ messageId: "m-1", index: 0, decision: "apply" });
    expect(res.status).toBe(200);
    expect(applyAction).toHaveBeenCalledWith("p-1", action);
    expect(repo.addAssistantMessage).toHaveBeenCalledWith({ projectId: "p-1", role: "assistant", content: "Done." });
    expect(repo.updateAssistantMessage).toHaveBeenLastCalledWith("m-1", {
      proposals: [{ state: "applied", action }],
    });
  });

  it("marks the proposal failed when the action is invalid", async () => {
    checkAction.mockReturnValue({ ok: false, problem: "Bad action." });
    const res = await decide({ messageId: "m-1", index: 0, decision: "apply" });
    expect(res.status).toBe(200);
    expect(applyAction).not.toHaveBeenCalled();
    expect(repo.updateAssistantMessage).toHaveBeenLastCalledWith("m-1", {
      proposals: [{ state: "failed", action, error: "Bad action." }],
    });
  });

  it("marks the proposal failed when applying throws", async () => {
    applyAction.mockRejectedValue(new Error("boom"));
    await decide({ messageId: "m-1", index: 0, decision: "apply" });
    expect(repo.updateAssistantMessage).toHaveBeenLastCalledWith("m-1", {
      proposals: [{ state: "failed", action, error: "boom" }],
    });
  });

  it.each([
    [{}],
    [{ messageId: "m-1", index: -1, decision: "apply" }],
    [{ messageId: "m-1", index: 0, decision: "maybe" }],
    [null],
  ])("rejects a malformed decision %j", async (body) => {
    expect((await decide(body)).status).toBe(400);
  });

  it("asks to sign in when there is no user", async () => {
    currentUser.mockResolvedValue(null);
    expect((await decide({ messageId: "m-1", index: 0, decision: "apply" })).status).toBe(401);
  });

  it("refuses when there is no active project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await decide({ messageId: "m-1", index: 0, decision: "apply" })).status).toBe(409);
  });

  it("answers 404 for a missing message, a missing index or another board's message", async () => {
    repo.assistantMessage.mockResolvedValueOnce(null);
    expect((await decide({ messageId: "x", index: 0, decision: "apply" })).status).toBe(404);
    expect((await decide({ messageId: "m-1", index: 5, decision: "apply" })).status).toBe(404);
    repo.assistantMessage.mockResolvedValueOnce({ id: "m-1", projectId: "other", proposals: [{ state: "proposed", action }] });
    expect((await decide({ messageId: "m-1", index: 0, decision: "apply" })).status).toBe(404);
    expect(applyAction).not.toHaveBeenCalled();
  });

  it("answers 409 for a proposal already decided", async () => {
    repo.assistantMessage.mockResolvedValue({ id: "m-1", projectId: "p-1", proposals: [{ state: "applied", action }] });
    expect((await decide({ messageId: "m-1", index: 0, decision: "apply" })).status).toBe(409);
    expect(applyAction).not.toHaveBeenCalled();
  });
});
