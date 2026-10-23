import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendNotification, repo } = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  repo: { pushSubscriptions: vi.fn(), deletePushSubscription: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("web-push", () => ({ default: { sendNotification } }));
vi.mock("@/lib/db", () => ({ repository: () => repo }));

const { sendPush } = await import("./send");

const a = { endpoint: "https://push.example/a", p256dh: "pa", auth: "aa" };
const b = { endpoint: "https://push.example/b", p256dh: "pb", auth: "ab" };

beforeEach(() => {
  vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
  vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
  vi.stubEnv("VAPID_SUBJECT", "mailto:x@example.com");
  sendNotification.mockReset().mockResolvedValue({});
  repo.pushSubscriptions.mockReset().mockResolvedValue([a, b]);
  repo.deletePushSubscription.mockReset().mockResolvedValue(undefined);
});

describe("sendPush", () => {
  it("pushes the payload to each of the person's devices", async () => {
    await sendPush("u1", { title: "T", body: "B" });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: a.endpoint, keys: { p256dh: "pa", auth: "aa" } },
      JSON.stringify({ title: "T", body: "B" }),
      expect.objectContaining({ vapidDetails: { subject: "mailto:x@example.com", publicKey: "pub", privateKey: "priv" } }),
    );
  });

  it.each([404, 410])("drops a subscription the push service answers %i to", async (statusCode) => {
    sendNotification.mockImplementation(async (s: { endpoint: string }) => {
      if (s.endpoint === a.endpoint) throw Object.assign(new Error("gone"), { statusCode });
    });
    await sendPush("u1", { title: "T", body: "B" });
    expect(repo.deletePushSubscription).toHaveBeenCalledTimes(1);
    expect(repo.deletePushSubscription).toHaveBeenCalledWith(a.endpoint, "u1");
  });

  it("keeps a subscription after another failure", async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error("busy"), { statusCode: 500 }));
    await sendPush("u1", { title: "T", body: "B" });
    expect(repo.deletePushSubscription).not.toHaveBeenCalled();
  });

  it("does nothing without VAPID keys", async () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    await sendPush("u1", { title: "T", body: "B" });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
