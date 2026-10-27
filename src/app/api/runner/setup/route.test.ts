import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, runnerSetup } = vi.hoisted(() => ({ activeProject: vi.fn(), runnerSetup: vi.fn() }));

vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "No board" }, { status: 409 }),
}));
vi.mock("@/lib/runner/setup", () => ({ runnerSetup }));

const { repository } = await import("@/lib/db");
const { GET } = await import("./route");

let project: { id: string; repoFullName: string; baseBranch: string };

beforeEach(async () => {
  vi.clearAllMocks();
  globalThis.__formicMemoryStore = undefined;
  const repo = repository();
  project = await repo.ensureProject({ ownerId: null, repoFullName: "a/board", baseBranch: "main" });
  const preset = await repo.savePreset({ provider: "anthropic", name: "Coder", model: "m", prompt: "p", ownerId: null });
  await repo.setColumnAgent(project.id, "in_progress", preset.id);
  activeProject.mockResolvedValue(project);
});

describe("GET /api/runner/setup with no agent on the board", () => {
  it("says ready without opening a pull request", async () => {
    await repository().setColumnAgent(project.id, "in_progress", null);
    expect(await (await GET()).json()).toEqual({ state: "ready" });
    expect(runnerSetup).not.toHaveBeenCalled();
  });
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
