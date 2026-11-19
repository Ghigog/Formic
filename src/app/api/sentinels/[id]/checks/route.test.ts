import { beforeEach, describe, expect, it, vi } from "vitest";

const { activeProject, currentUser, sentinelsFor, editRubricCheck } = vi.hoisted(() => ({
  activeProject: vi.fn(),
  currentUser: vi.fn(),
  sentinelsFor: vi.fn(),
  editRubricCheck: vi.fn(),
}));

vi.mock("@/lib/sentinels/service", () => ({ sentinelsFor, editRubricCheck }));
vi.mock("@/lib/auth/user", () => ({ currentUser, asSignedIn: <T,>(handler: T) => handler }));
vi.mock("@/lib/board/project", () => ({
  activeProject,
  noProject: () => Response.json({ error: "Pick a repository first." }, { status: 409 }),
}));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const call = (body: unknown = { checkId: "3a", note: "Name OverlayService.kt" }) =>
  POST(new Request("http://localhost/api/sentinels/s1/checks", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "s1" }),
  });

beforeEach(() => {
  clearBuckets();
  currentUser.mockReset().mockResolvedValue({ id: "u1" });
  activeProject.mockReset().mockResolvedValue({ id: "p1" });
  sentinelsFor.mockReset().mockResolvedValue({ s1: {} });
  editRubricCheck.mockReset().mockResolvedValue({ ok: true });
});

describe("POST /api/sentinels/[id]/checks", () => {
  it("edits the check as the signed-in user and answers the states", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sentinels: { s1: {} } });
    expect(editRubricCheck).toHaveBeenCalledWith("p1", "s1", "3a", "Name OverlayService.kt", "u1");
  });

  it("refuses when nobody is signed in", async () => {
    currentUser.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(editRubricCheck).not.toHaveBeenCalled();
  });

  it("refuses someone who is not a member of the board", async () => {
    activeProject.mockResolvedValue(null);
    expect((await call()).status).toBe(409);
    expect(editRubricCheck).not.toHaveBeenCalled();
  });

  it("refuses an empty note", async () => {
    expect((await call({ checkId: "3a", note: "  " })).status).toBe(400);
    expect(editRubricCheck).not.toHaveBeenCalled();
  });

  it("passes on the service's refusal", async () => {
    editRubricCheck.mockResolvedValue({ ok: false, error: "No check 9z.", status: 404 });
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No check 9z." });
  });
});
