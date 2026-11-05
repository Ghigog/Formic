import { beforeEach, describe, expect, it, vi } from "vitest";

const { archivedTickets, archivedEpics, activeProject } = vi.hoisted(() => ({
  archivedTickets: vi.fn(),
  archivedEpics: vi.fn(),
  activeProject: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ archivedTickets, archivedEpics }) }));
vi.mock("@/lib/board/project", () => ({ activeProject }));

const { GET } = await import("./route");

const get = (cursor?: string) =>
  GET(new Request(`http://localhost/api/tickets/archived${cursor ? `?cursor=${cursor}` : ""}`));

beforeEach(() => vi.clearAllMocks());

describe("GET /api/tickets/archived", () => {
  it("lists the active project's archived tickets and Epics", async () => {
    activeProject.mockResolvedValue({ id: "p-1" });
    archivedTickets.mockResolvedValue({ cards: [{ id: "t-1" }], nextCursor: null });
    archivedEpics.mockResolvedValue({ cards: [{ id: "e-1" }], nextCursor: null });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tickets: [{ id: "t-1" }], epics: [{ id: "e-1" }], nextCursor: null });
    expect(archivedTickets).toHaveBeenCalledWith("p-1", { cursor: undefined });
  });

  it("pages both lists with one opaque cursor until it is null", async () => {
    activeProject.mockResolvedValue({ id: "p-1" });
    archivedTickets.mockResolvedValueOnce({ cards: [{ id: "t-1" }], nextCursor: "t-1" });
    archivedEpics.mockResolvedValueOnce({ cards: [{ id: "e-1" }], nextCursor: null });
    const first = await (await get()).json();
    expect(first.nextCursor).toEqual(expect.any(String));

    archivedTickets.mockResolvedValueOnce({ cards: [{ id: "t-2" }], nextCursor: null });
    const second = await (await get(first.nextCursor)).json();
    expect(archivedTickets).toHaveBeenLastCalledWith("p-1", { cursor: "t-1" });
    expect(archivedEpics).toHaveBeenCalledTimes(1); // that list was spent
    expect(second).toEqual({ tickets: [{ id: "t-2" }], epics: [], nextCursor: null });
  });

  it("refuses a cursor it did not issue", async () => {
    activeProject.mockResolvedValue({ id: "p-1" });
    expect((await get("garbage")).status).toBe(400);
  });

  it("lists nothing without an active project", async () => {
    activeProject.mockResolvedValue(null);
    expect(await (await get()).json()).toEqual({ tickets: [], epics: [], nextCursor: null });
    expect(archivedTickets).not.toHaveBeenCalled();
    expect(archivedEpics).not.toHaveBeenCalled();
  });
});
