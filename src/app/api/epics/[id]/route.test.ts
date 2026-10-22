import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  activeProject: vi.fn(),
  projectOfCard: vi.fn(),
  epicDetail: vi.fn(),
  boardCards: vi.fn(),
  applyPrd: vi.fn(),
  retryEpic: vi.fn(),
  deleteEpic: vi.fn(),
}));

vi.mock("@/lib/board/project", () => ({ activeProject: m.activeProject }));
vi.mock("@/lib/db", () => ({
  repository: () => ({
    projectOfCard: m.projectOfCard,
    epicDetail: m.epicDetail,
    boardCards: m.boardCards,
  }),
}));
vi.mock("@/lib/agents/pipeline", () => ({ applyPrd: m.applyPrd }));
vi.mock("@/lib/board/service", () => ({
  canRetryEpic: () => true,
  canGenerateShowcase: () => false,
  retryEpic: m.retryEpic,
  deleteEpic: m.deleteEpic,
}));

const { GET, PATCH, POST, DELETE } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const ctx = { params: Promise.resolve({ id: "e-1" }) };
const prd = {
  summary: "S",
  problem: "P",
  scope: ["a"],
  successCriteria: ["b"],
};

beforeEach(() => {
  clearBuckets();
  Object.values(m).forEach((f) => f.mockReset());
  m.activeProject.mockResolvedValue({ id: "project_default" });
  m.projectOfCard.mockResolvedValue("project_default");
  m.epicDetail.mockResolvedValue({ title: "T", rawRequest: "R", prd: null, showcase: null });
  m.boardCards.mockResolvedValue([
    { id: "e-1", epicId: "e-1" },
    { id: "t-1", epicId: "e-1" },
    { id: "t-2", epicId: "e-2" },
  ]);
});

function patch(body: unknown) {
  return PATCH(
    new NextRequest("http://localhost/api/epics/e-1", { method: "PATCH", body: JSON.stringify(body) }),
    ctx,
  );
}
const req = (method: string) => new NextRequest("http://localhost/api/epics/e-1", { method });

describe("GET /api/epics/[id]", () => {
  it("returns the epic with its children", async () => {
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("T");
    expect(body.epic.id).toBe("e-1");
    expect(body.children.map((c: { id: string }) => c.id)).toEqual(["e-1", "t-1"]);
    expect(body.canRetry).toBe(true);
  });

  it("answers 404 for an Epic outside the active project", async () => {
    m.projectOfCard.mockResolvedValue("someone-else");
    expect((await GET(req("GET"), ctx)).status).toBe(404);
  });

  it("answers 404 when the Epic has no detail", async () => {
    m.epicDetail.mockResolvedValue(null);
    expect((await GET(req("GET"), ctx)).status).toBe(404);
  });
});

describe("PATCH /api/epics/[id]", () => {
  it("saves an edited PRD", async () => {
    const res = await patch({ prd });
    expect(res.status).toBe(200);
    expect(m.applyPrd).toHaveBeenCalledWith(
      "project_default",
      "e-1",
      expect.objectContaining({ summary: "S", outOfScope: [] }),
      true,
    );
  });

  it("answers 400 for a bad body", async () => {
    const res = await patch({ prd: { summary: "" } });
    expect(res.status).toBe(400);
    expect(m.applyPrd).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown Epic", async () => {
    m.projectOfCard.mockResolvedValue(null);
    expect((await patch({ prd })).status).toBe(404);
  });
});

describe("POST and DELETE /api/epics/[id]", () => {
  it("retries a stalled Epic, passing a refusal on", async () => {
    m.retryEpic.mockResolvedValueOnce({ ok: true });
    expect((await POST(req("POST"), ctx)).status).toBe(200);
    m.retryEpic.mockResolvedValueOnce({ ok: false, status: 409, reason: "No." });
    const res = await POST(req("POST"), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "No." });
  });

  it("answers 429 over the limit", async () => {
    m.retryEpic.mockResolvedValue({ ok: true });
    for (let i = 0; i < 60; i++) expect((await POST(req("POST"), ctx)).status).toBe(200);
    expect((await POST(req("POST"), ctx)).status).toBe(429);
  });

  it("deletes an Epic, and 404s for an unknown one", async () => {
    m.deleteEpic.mockResolvedValue({ ok: true });
    expect((await DELETE(req("DELETE"), ctx)).status).toBe(200);
    expect(m.deleteEpic).toHaveBeenCalledWith("project_default", "e-1");
    m.projectOfCard.mockResolvedValue(null);
    expect((await DELETE(req("DELETE"), ctx)).status).toBe(404);
  });
});
