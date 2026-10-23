import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUser, repo } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  repo: { savePushSubscription: vi.fn(), deletePushSubscription: vi.fn() },
}));

vi.mock("@/lib/auth/user", () => ({ currentUser }));
vi.mock("@/lib/db", () => ({ repository: () => repo }));

const { POST, DELETE } = await import("./route");

const req = (method: string, body: unknown) =>
  new Request("http://localhost/api/push/subscriptions", { method, body: JSON.stringify(body) });
const sub = { endpoint: "https://push.example/a", keys: { p256dh: "pk", auth: "ak" } };

beforeEach(() => {
  currentUser.mockReset().mockResolvedValue({ id: "u1" });
  repo.savePushSubscription.mockReset().mockResolvedValue(undefined);
  repo.deletePushSubscription.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/push/subscriptions", () => {
  it("saves the device's subscription for the person", async () => {
    expect((await POST(req("POST", sub))).status).toBe(200);
    expect(repo.savePushSubscription).toHaveBeenCalledWith("u1", { endpoint: sub.endpoint, p256dh: "pk", auth: "ak" });
  });

  it("answers 400 for a malformed subscription", async () => {
    expect((await POST(req("POST", { endpoint: "nope" }))).status).toBe(400);
    expect(repo.savePushSubscription).not.toHaveBeenCalled();
  });

  it("answers 401 when signed out", async () => {
    currentUser.mockResolvedValue(null);
    expect((await POST(req("POST", sub))).status).toBe(401);
  });
});

describe("DELETE /api/push/subscriptions", () => {
  it("forgets the device, for this person only", async () => {
    expect((await DELETE(req("DELETE", { endpoint: sub.endpoint }))).status).toBe(200);
    expect(repo.deletePushSubscription).toHaveBeenCalledWith(sub.endpoint, "u1");
  });

  it("answers 401 when signed out", async () => {
    currentUser.mockResolvedValue(null);
    expect((await DELETE(req("DELETE", { endpoint: sub.endpoint }))).status).toBe(401);
  });
});
