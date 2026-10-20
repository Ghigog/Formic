import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, boardCards, setColony, startQueued } = vi.hoisted(() => ({
  activeProject: vi.fn(),
  boardCards: vi.fn(),
  setColony: vi.fn(),
  startQueued: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ boardCards, setColony }) }));
vi.mock("@/lib/board/queue", () => ({ startQueued }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { GET, POST } = await import("./route");

const project = { id: "p1", colonySize: null, colonyReserve: 0, autoScout: false };
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/colony", { method: "POST", body: JSON.stringify(body) }) as never);

beforeEach(() => {
  activeProject.mockReset().mockResolvedValue(project);
  boardCards.mockReset().mockResolvedValue([]);
  setColony.mockReset();
  startQueued.mockReset();
});

describe("/api/colony", () => {
  it("GET answers the colony as the Nest shows it", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ level: expect.any(Number), inUse: expect.anything() });
    expect(boardCards).toHaveBeenCalledWith("p1");
  });

  it("GET answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await GET()).status).toBe(409);
  });

  it("POST saves the colony and starts what is queued", async () => {
    const res = await post({ colonySize: 2, colonyReserve: 0, autoScout: false });
    expect(res.status).toBe(200);
    expect(setColony).toHaveBeenCalledWith("p1", expect.objectContaining({ colonySize: 2 }));
    expect(startQueued).toHaveBeenCalledWith("p1");
  });

  it("POST answers 400 for a bad body", async () => {
    expect((await post({ colonySize: "big" })).status).toBe(400);
    expect(setColony).not.toHaveBeenCalled();
  });

  it("POST answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await post({ colonySize: 2, colonyReserve: 0, autoScout: false })).status).toBe(409);
    expect(setColony).not.toHaveBeenCalled();
  });
});
