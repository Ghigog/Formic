import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { generateShowcase, activeProject, projectOfCard } = vi.hoisted(() => ({
  generateShowcase: vi.fn(),
  activeProject: vi.fn(),
  projectOfCard: vi.fn(),
}));

vi.mock("@/lib/board/service", () => ({ generateShowcase }));
vi.mock("@/lib/board/project", () => ({ activeProject }));
vi.mock("@/lib/db", () => ({ repository: () => ({ projectOfCard }) }));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

beforeEach(() => {
  clearBuckets();
  generateShowcase.mockReset();
  activeProject.mockResolvedValue({ id: "project_default" });
  projectOfCard.mockResolvedValue("project_default");
});

function post() {
  return POST(new NextRequest("http://localhost/api/epics/e-1/showcase", { method: "POST" }), {
    params: Promise.resolve({ id: "e-1" }),
  });
}

describe("POST /api/epics/[id]/showcase", () => {
  it("answers 404 for an Epic outside the active project", async () => {
    projectOfCard.mockResolvedValue("someone-else");

    expect((await post()).status).toBe(404);
    expect(generateShowcase).not.toHaveBeenCalled();
  });

  it("passes the refusal on as 409", async () => {
    generateShowcase.mockResolvedValue({ ok: false, status: 409, reason: "CARD is not done yet." });

    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "CARD is not done yet." });
  });

  it("starts the showcase and answers 200", async () => {
    generateShowcase.mockResolvedValue({ ok: true });

    expect((await post()).status).toBe(200);
    expect(generateShowcase).toHaveBeenCalledWith("project_default", "e-1");
  });
});
