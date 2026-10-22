import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, runnerSetup } = vi.hoisted(() => ({ activeProject: vi.fn(), runnerSetup: vi.fn() }));

vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "No board" }, { status: 409 }),
}));
vi.mock("@/lib/runner/setup", () => ({ runnerSetup }));

const { GET } = await import("./route");

const project = { id: "p-1", repoFullName: "a/board", baseBranch: "main" };

beforeEach(() => {
  vi.clearAllMocks();
  activeProject.mockResolvedValue(project);
});

describe("GET /api/runner/setup", () => {
  it("reports the project's setup state", async () => {
    runnerSetup.mockResolvedValue({ state: "waiting", setupUrl: "https://x/pull/1", update: false });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "waiting", setupUrl: "https://x/pull/1", update: false });
    expect(runnerSetup).toHaveBeenCalledWith(project);
  });

  it("answers with the no-board response when no project is active", async () => {
    activeProject.mockResolvedValue(null);
    expect((await GET()).status).toBe(409);
    expect(runnerSetup).not.toHaveBeenCalled();
  });

  it("answers 502 blocked with the reason when setup throws", async () => {
    runnerSetup.mockRejectedValue(new Error("no permission"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ state: "blocked", reason: "no permission" });
  });
});
