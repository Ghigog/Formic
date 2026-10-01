import { beforeEach, describe, expect, it, vi } from "vitest";
import { SENTINELS } from "@/lib/sentinels/roster";

const { createBacklogItem, activeProject, sentinelsFor } = vi.hoisted(() => ({
  createBacklogItem: vi.fn(),
  activeProject: vi.fn(),
  sentinelsFor: vi.fn(),
}));

vi.mock("@/lib/board/service", () => ({ createBacklogItem }));
vi.mock("@/lib/sentinels/service", () => ({ sentinelsFor }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const id = SENTINELS[0]!.id;
const report = { likes: [], dislikes: [], wrong: [{ text: "Bug", ref: "a.ts" }], missing: [] };
const call = () =>
  POST(new Request(`http://localhost/api/sentinels/${id}/epic`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  clearBuckets();
  createBacklogItem.mockReset().mockResolvedValue({ id: "epic-1" });
  activeProject.mockResolvedValue({ id: "p1" });
});

describe("POST /api/sentinels/[id]/epic", () => {
  it("creates a Backlog item from a 3-star report", async () => {
    sentinelsFor.mockResolvedValue({ [id]: { stars: 3, summary: "Meh", report } });
    const res = await call();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ card: { id: "epic-1" } });
    expect(createBacklogItem).toHaveBeenCalledWith("p1", expect.stringContaining("Bug (a.ts)"));
  });

  it("answers 404 when the sentinel has not reported", async () => {
    sentinelsFor.mockResolvedValue({ [id]: { stars: null, summary: null, report: null } });
    expect((await call()).status).toBe(404);
    expect(createBacklogItem).not.toHaveBeenCalled();
  });

  it("answers 409 at 5 stars", async () => {
    sentinelsFor.mockResolvedValue({ [id]: { stars: 5, summary: "Great", report } });
    expect((await call()).status).toBe(409);
    expect(createBacklogItem).not.toHaveBeenCalled();
  });
});
