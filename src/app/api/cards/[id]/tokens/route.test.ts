import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, cardTokensFor } = vi.hoisted(() => ({ activeProject: vi.fn(), cardTokensFor: vi.fn() }));

vi.mock("@/lib/kpi/card-tokens", () => ({ cardTokensFor }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { GET } = await import("./route");
const call = (query = "") =>
  GET(new Request(`http://localhost/api/cards/c1/tokens${query}`), { params: Promise.resolve({ id: "c1" }) });

beforeEach(() => {
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  cardTokensFor.mockReset().mockResolvedValue({ stays: [], totalIn: 0, totalOut: 0, unreported: false });
});

describe("GET /api/cards/[id]/tokens", () => {
  it("answers the card's tokens, as a ticket by default", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).totalIn).toBe(0);
    expect(cardTokensFor).toHaveBeenCalledWith("p1", "ticket", "c1");
  });

  it("reads kind=epic", async () => {
    await call("?kind=epic");
    expect(cardTokensFor).toHaveBeenCalledWith("p1", "epic", "c1");
  });

  it("answers 404 for a card outside the project", async () => {
    cardTokensFor.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("answers 409 without a project", async () => {
    activeProject.mockResolvedValue(null);
    expect((await call()).status).toBe(409);
  });
});
