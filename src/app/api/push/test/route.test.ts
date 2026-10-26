import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUser, repo, push } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  repo: { pushSubscriptions: vi.fn() },
  push: { pushConfigured: vi.fn(), sendPush: vi.fn() },
}));

vi.mock("@/lib/auth/user", () => ({ currentUser }));
vi.mock("@/lib/db", () => ({ repository: () => repo }));
vi.mock("@/lib/push/send", () => push);

const { POST } = await import("./route");

beforeEach(() => {
  currentUser.mockReset().mockResolvedValue({ id: "u1" });
  repo.pushSubscriptions.mockReset().mockResolvedValue([{ endpoint: "https://push.example/a" }]);
  push.pushConfigured.mockReset().mockReturnValue(true);
  push.sendPush.mockReset().mockResolvedValue({ sent: 1, failed: 0 });
});

describe("POST /api/push/test", () => {
  it("sends a test push to the person", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(push.sendPush).toHaveBeenCalledWith("u1", expect.objectContaining({ title: "Formic" }));
  });

  it("answers 503 when the server has no VAPID keys", async () => {
    push.pushConfigured.mockReturnValue(false);
    expect((await POST()).status).toBe(503);
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it("answers 404 when no device is enabled", async () => {
    repo.pushSubscriptions.mockResolvedValue([]);
    expect((await POST()).status).toBe(404);
  });

  it("answers 502 when no device took it", async () => {
    push.sendPush.mockResolvedValue({ sent: 0, failed: 1 });
    expect((await POST()).status).toBe(502);
  });

  it("answers 401 when signed out", async () => {
    currentUser.mockResolvedValue(null);
    expect((await POST()).status).toBe(401);
  });
});
