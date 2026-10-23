import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { activeProject, ticketDetail, scoutViews, sendScouts, removeScout, swapScout } = vi.hoisted(() => ({
  activeProject: vi.fn(),
  ticketDetail: vi.fn(),
  scoutViews: vi.fn(),
  sendScouts: vi.fn(),
  removeScout: vi.fn(),
  swapScout: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ ticketDetail }) }));
vi.mock("@/lib/coder/scouts", () => ({ scoutViews, sendScouts, removeScout, swapScout }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { GET, POST } = await import("./route");

const get = (query: string) => GET(new NextRequest(`http://localhost/api/scouts${query}`));
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/scouts", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  ticketDetail.mockReset().mockResolvedValue({ projectId: "p1" });
  scoutViews.mockReset().mockResolvedValue([{ id: "s1" }]);
  sendScouts.mockReset().mockResolvedValue({ ok: true });
  swapScout.mockReset().mockResolvedValue({ ok: true });
  removeScout.mockReset().mockResolvedValue({ ok: true });
});

describe("GET /api/scouts", () => {
  it("answers a ticket's scouts", async () => {
    const res = await get("?ticketId=t1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "s1" }]);
  });

  it("answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await get("?ticketId=t1")).status).toBe(409);
  });

  it("answers 400 without a ticketId", async () => {
    expect((await get("")).status).toBe(400);
  });

  it("answers 404 for a missing ticket or another project's", async () => {
    ticketDetail.mockResolvedValue(null);
    expect((await get("?ticketId=t1")).status).toBe(404);
    ticketDetail.mockResolvedValue({ projectId: "other" });
    expect((await get("?ticketId=t1")).status).toBe(404);
  });
});

describe("POST /api/scouts", () => {
  it("sends scouts", async () => {
    const res = await post({ action: "send", ticketId: "t1" });
    expect(res.status).toBe(200);
    expect(sendScouts).toHaveBeenCalledWith("p1", "t1");
    expect(await res.json()).toEqual([{ id: "s1" }]);
  });

  it("swaps a scout", async () => {
    const res = await post({ action: "swap", ticketId: "t1", scoutId: "s1" });
    expect(res.status).toBe(200);
    expect(swapScout).toHaveBeenCalledWith("p1", "t1", "s1");
  });

  it("removes a scout", async () => {
    const res = await post({ action: "remove", ticketId: "t1", scoutId: "s1" });
    expect(res.status).toBe(200);
    expect(removeScout).toHaveBeenCalledWith("p1", "t1", "s1");
  });

  it("answers 409 with the reason when a scout cannot be removed", async () => {
    removeScout.mockResolvedValue({ ok: false, reason: "That scout is not on this ticket." });
    expect((await post({ action: "remove", ticketId: "t1", scoutId: "x" })).status).toBe(409);
  });

  it("answers 400 for a bad body", async () => {
    expect((await post({ action: "swap", ticketId: "t1" })).status).toBe(400);
  });

  it("answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await post({ action: "send", ticketId: "t1" })).status).toBe(409);
  });

  it("answers 409 with the reason when refused", async () => {
    sendScouts.mockResolvedValue({ ok: false, reason: "Not in progress." });
    const res = await post({ action: "send", ticketId: "t1" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Not in progress." });
  });
});
