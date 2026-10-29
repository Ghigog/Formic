import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, boardCards, goldenBell, setGoldenBellArmed, useGoldenBell, ringBell, level } = vi.hoisted(() => ({
  activeProject: vi.fn(),
  boardCards: vi.fn(),
  goldenBell: vi.fn(),
  setGoldenBellArmed: vi.fn(),
  useGoldenBell: vi.fn(),
  ringBell: vi.fn(),
  level: { value: 12 },
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ boardCards, goldenBell, setGoldenBellArmed, useGoldenBell }) }));
vi.mock("@/lib/colony/bell", () => ({ ringBell }));
vi.mock("@/lib/colony/game", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/colony/game")>()),
  scoreOf: () => ({ level: level.value }),
}));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { GET, POST } = await import("./route");

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/bell", { method: "POST", body: JSON.stringify(body) }) as never);

beforeEach(() => {
  level.value = 12;
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  boardCards.mockReset().mockResolvedValue([]);
  goldenBell.mockReset().mockResolvedValue({ used: 0, armed: false });
  setGoldenBellArmed.mockReset();
  useGoldenBell.mockReset();
  ringBell.mockReset().mockResolvedValue({ sent: 1, skipped: 0 });
});

describe("/api/bell", () => {
  it("GET answers the golden bells left and whether one is armed", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ left: 2, armed: false });
  });

  it("GET answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await GET()).status).toBe(409);
  });

  it("POST ring runs the silver bell and uses up no golden bell", async () => {
    const res = await post({ action: "ring" });
    expect(res.status).toBe(200);
    expect(ringBell).toHaveBeenCalledWith("p1");
    expect(useGoldenBell).not.toHaveBeenCalled();
    expect(setGoldenBellArmed).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ sent: 1, left: 2 });
  });

  it("POST arm arms the golden bell", async () => {
    const res = await post({ action: "arm" });
    expect(res.status).toBe(200);
    expect(setGoldenBellArmed).toHaveBeenCalledWith("p1", true);
  });

  it("POST arm answers 400 and stays disarmed when none is left", async () => {
    goldenBell.mockResolvedValue({ used: 2, armed: false });
    const res = await post({ action: "arm" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ left: 0, armed: false });
    expect(setGoldenBellArmed).not.toHaveBeenCalled();
  });

  it("POST disarm disarms even with none left", async () => {
    goldenBell.mockResolvedValue({ used: 2, armed: true });
    expect((await post({ action: "disarm" })).status).toBe(200);
    expect(setGoldenBellArmed).toHaveBeenCalledWith("p1", false);
  });

  it("POST answers 400 for a bad action", async () => {
    expect((await post({ action: "bang" })).status).toBe(400);
  });
});
