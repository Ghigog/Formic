import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { repo, activeProject, service } = vi.hoisted(() => ({
  repo: { projectOfCard: vi.fn() },
  activeProject: vi.fn(),
  service: { archiveEpic: vi.fn(), restoreEpic: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/board/project", () => ({ activeProject }));
vi.mock("@/lib/board/service", () => service);

const { PATCH, DELETE } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const params = { params: Promise.resolve({ id: "e-1" }) };
const req = (method: string) => new NextRequest("http://localhost/api/epics/e-1/archive", { method });

beforeEach(() => {
  clearBuckets();
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1" });
  repo.projectOfCard.mockResolvedValue("p-1");
});

describe("PATCH /api/epics/[id]/archive", () => {
  it("archives the Epic", async () => {
    service.archiveEpic.mockResolvedValue({ ok: true });
    const res = await PATCH(req("PATCH"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: true });
    expect(service.archiveEpic).toHaveBeenCalledWith("p-1", "e-1");
  });

  it("returns 409 naming the running ticket", async () => {
    service.archiveEpic.mockResolvedValue({ ok: false, reason: "T-3 has an agent working.", status: 409 });
    const res = await PATCH(req("PATCH"), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("T-3");
  });

  it("404s for an Epic of another project", async () => {
    repo.projectOfCard.mockResolvedValue("p-2");
    expect((await PATCH(req("PATCH"), params)).status).toBe(404);
    expect(service.archiveEpic).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/epics/[id]/archive", () => {
  it("restores the Epic", async () => {
    service.restoreEpic.mockResolvedValue({ ok: true });
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: false });
    expect(service.restoreEpic).toHaveBeenCalledWith("p-1", "e-1");
  });

  it("404s without an active project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await DELETE(req("DELETE"), params)).status).toBe(404);
  });
});
