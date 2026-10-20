import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { projectOfCard, activeProject, stopTicket } = vi.hoisted(() => ({
  projectOfCard: vi.fn(),
  activeProject: vi.fn(),
  stopTicket: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ projectOfCard }) }));
vi.mock("@/lib/board/project", () => ({ activeProject }));
vi.mock("@/lib/runner/runner", () => ({ stopTicket }));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const params = { params: Promise.resolve({ id: "t-1" }) };
const call = () => POST(new NextRequest("http://localhost/api/tickets/t-1/stop", { method: "POST" }), params);

beforeEach(() => {
  clearBuckets();
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1" });
  projectOfCard.mockResolvedValue("p-1");
});

describe("POST /api/tickets/[id]/stop", () => {
  it("stops a working ticket", async () => {
    stopTicket.mockResolvedValue(true);
    const res = await call();
    expect(res.status).toBe(200);
    expect(stopTicket).toHaveBeenCalledWith("p-1", "t-1");
  });

  it("409s when nothing is working the ticket", async () => {
    stopTicket.mockResolvedValue(false);
    expect((await call()).status).toBe(409);
  });

  it("404s for a ticket of another project", async () => {
    projectOfCard.mockResolvedValue("p-2");
    expect((await call()).status).toBe(404);
  });

  it("429s over the limit", async () => {
    stopTicket.mockResolvedValue(true);
    for (let i = 0; i < 60; i++) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });
});
