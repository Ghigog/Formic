import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { cardById, projectOfCard, activeProject, applyTransition } = vi.hoisted(() => ({
  cardById: vi.fn(),
  projectOfCard: vi.fn(),
  activeProject: vi.fn(),
  applyTransition: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ repository: () => ({ cardById, projectOfCard }) }));
vi.mock("@/lib/board/service", () => ({ applyTransition }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

beforeEach(() => {
  clearBuckets();
  vi.clearAllMocks();
  activeProject.mockResolvedValue({ id: "p-1" });
  projectOfCard.mockResolvedValue("p-1");
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/transitions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/transitions", () => {
  it("reverts a malformed move of a known card to its current column", async () => {
    cardById.mockResolvedValue({ id: "c-1", status: "ready" });
    const res = await POST(request({ cardId: "c-1", to: "nowhere" }));
    expect(res.status).toBe(400);
    expect((await res.json()).revertTo).toBe("todo");
    expect(applyTransition).not.toHaveBeenCalled();
  });

  it("omits revertTo for a card on another board", async () => {
    cardById.mockResolvedValue({ id: "c-9", status: "ready" });
    projectOfCard.mockResolvedValue("p-2");
    const res = await POST(request({ cardId: "c-9", to: "nowhere" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("Malformed transition request.");
    expect("revertTo" in json).toBe(false);
  });

  it("omits revertTo when there is no active project", async () => {
    activeProject.mockResolvedValue(null);
    const res = await POST(request({ cardId: "c-1", to: "nowhere" }));
    expect(res.status).toBe(400);
    expect("revertTo" in (await res.json())).toBe(false);
  });

  it("omits revertTo when the card is not known", async () => {
    cardById.mockResolvedValue(null);
    const res = await POST(request({ cardId: "ghost" }));
    expect(res.status).toBe(400);
    expect("revertTo" in (await res.json())).toBe(false);
  });

  it("omits revertTo when the body has no cardId", async () => {
    const res = await POST(request("garbage"));
    expect(res.status).toBe(400);
    expect("revertTo" in (await res.json())).toBe(false);
  });
});
