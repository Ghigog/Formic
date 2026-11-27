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

const project = { id: "p1", colonyMode: "off", colonySize: null, colonyReserve: 0, autoScout: false };
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
    const res = await post({ colonyMode: "manual", colonySize: 2, colonyReserve: 0, autoScout: false });
    expect(res.status).toBe(200);
    expect(setColony).toHaveBeenCalledWith("p1", expect.objectContaining({ colonyMode: "manual", colonySize: 2 }));
    expect(startQueued).toHaveBeenCalledWith("p1");
  });

  it("GET at Lv 1 answers Automatic: 2 at once, none reserved, and when it grows", async () => {
    activeProject.mockResolvedValue({ ...project, colonyMode: "auto" });
    expect(await (await GET()).json()).toMatchObject({
      colonyMode: "auto",
      colonySize: 2,
      colonyReserve: 0,
      autoSize: 2,
      autoReserve: 0,
      nextAutoLevel: 2,
    });
  });

  it("POST round-trips each mode, storing a number only for manual", async () => {
    const body = { colonyReserve: 0, autoScout: false };
    const auto = await post({ ...body, colonyMode: "auto", colonySize: 5 });
    expect(await auto.json()).toMatchObject({ colonyMode: "auto", colonySize: 2 });
    expect(setColony).toHaveBeenLastCalledWith("p1", expect.objectContaining({ colonyMode: "auto", colonySize: null }));
    const off = await post({ ...body, colonyMode: "off", colonySize: 5 });
    expect(await off.json()).toMatchObject({ colonyMode: "off", colonySize: null });
    expect(setColony).toHaveBeenLastCalledWith("p1", expect.objectContaining({ colonyMode: "off", colonySize: null }));
    const manual = await post({ ...body, colonyMode: "manual", colonySize: 12 });
    expect(await manual.json()).toMatchObject({ colonyMode: "manual", colonySize: 12 });
    expect((await post({ ...body, colonyMode: "manual", colonySize: null })).status).toBe(400);
    expect((await post({ ...body, colonyMode: "manual", colonySize: 13 })).status).toBe(400);
  });

  it("POST answers 400 for a bad body", async () => {
    expect((await post({ colonySize: "big" })).status).toBe(400);
    expect(setColony).not.toHaveBeenCalled();
  });

  it("POST answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await post({ colonyMode: "manual", colonySize: 2, colonyReserve: 0, autoScout: false })).status).toBe(409);
    expect(setColony).not.toHaveBeenCalled();
  });
});
