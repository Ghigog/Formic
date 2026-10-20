import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, currentUser, activeProject, ownsPreset } = vi.hoisted(() => ({
  repo: { setAssistantAgent: vi.fn() },
  currentUser: vi.fn(),
  activeProject: vi.fn(),
  ownsPreset: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/auth/user", () => ({ currentUser }));
vi.mock("@/lib/board/project", () => ({ activeProject, noProject: () => Response.json({}, { status: 409 }) }));
vi.mock("../../agents/presets/validate", () => ({ ownsPreset }));

const { PUT } = await import("./route");

function put(body: unknown) {
  return PUT(new Request("http://localhost/api/assistant/agent", { method: "PUT", body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.mockResolvedValue({ id: "u-1" });
  activeProject.mockResolvedValue({ id: "p-1" });
  ownsPreset.mockResolvedValue(true);
});

describe("PUT /api/assistant/agent", () => {
  it("sets the agent the assistant runs on", async () => {
    const res = await put({ presetId: "preset-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ presetId: "preset-1" });
    expect(repo.setAssistantAgent).toHaveBeenCalledWith("p-1", "preset-1");
  });

  it("clears the agent with null, without checking ownership", async () => {
    const res = await put({ presetId: null });
    expect(res.status).toBe(200);
    expect(ownsPreset).not.toHaveBeenCalled();
    expect(repo.setAssistantAgent).toHaveBeenCalledWith("p-1", null);
  });

  it.each([[{}], [{ presetId: "" }], [null]])("rejects a malformed body %j", async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(repo.setAssistantAgent).not.toHaveBeenCalled();
  });

  it("asks to sign in when there is no user", async () => {
    currentUser.mockResolvedValue(null);
    expect((await put({ presetId: "preset-1" })).status).toBe(401);
  });

  it("answers 404 for an agent the user does not own", async () => {
    ownsPreset.mockResolvedValue(false);
    expect((await put({ presetId: "preset-1" })).status).toBe(404);
    expect(repo.setAssistantAgent).not.toHaveBeenCalled();
  });

  it("refuses when there is no active project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await put({ presetId: "preset-1" })).status).toBe(409);
  });
});
