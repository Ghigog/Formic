// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationsSection } from "./notifications-section";

const subscription = { toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }) };
const subscribe = vi.fn().mockResolvedValue(subscription);
const requestPermission = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  subscribe.mockClear();
  fetchMock.mockReset().mockResolvedValue({ ok: true });
  requestPermission.mockReset().mockResolvedValue("granted");
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Notification", { requestPermission });
  vi.stubGlobal("PushManager", class {});
  const registration = { pushManager: { subscribe, getSubscription: async () => null } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
      getRegistration: async () => undefined,
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationsSection", () => {
  it("shows all three switches on by default", () => {
    render(<NotificationsSection vapidPublicKey="AAAA" />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
    for (const s of switches) expect(s).toBeChecked();
  });

  it("saves a switch through the settings API", async () => {
    render(<NotificationsSection vapidPublicKey="AAAA" />);
    await userEvent.click(screen.getByLabelText("Epic completed"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({ body: JSON.stringify({ notifications: { epicCompleted: false } }) }),
    );
    await waitFor(() => expect(screen.getByLabelText("Epic completed")).not.toBeChecked());
  });

  it("asks permission only on a tap, then subscribes and reads Enabled", async () => {
    render(<NotificationsSection vapidPublicKey="AAAA" />);
    expect(requestPermission).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Enable on this device" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Enabled" })).toBeDisabled());
    expect(subscribe).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/push/subscriptions",
      expect.objectContaining({ method: "POST", body: JSON.stringify(subscription.toJSON()) }),
    );
  });

  it("does not subscribe when permission is refused", async () => {
    requestPermission.mockResolvedValue("denied");
    render(<NotificationsSection vapidPublicKey="AAAA" />);
    await userEvent.click(screen.getByRole("button", { name: "Enable on this device" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(subscribe).not.toHaveBeenCalled();
  });

  describe("with a subscription the browser already has", () => {
    function existing(key: Uint8Array) {
      const unsubscribe = vi.fn().mockResolvedValue(true);
      const sub = { ...subscription, options: { applicationServerKey: key.buffer }, unsubscribe };
      const registration = { pushManager: { subscribe, getSubscription: async () => sub } };
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { register: vi.fn(), ready: Promise.resolve(registration), getRegistration: async () => registration },
      });
      return { unsubscribe };
    }

    it("saves it to the server again and reads Enabled", async () => {
      existing(new Uint8Array([0, 0, 0]));
      render(<NotificationsSection vapidPublicKey="AAAA" />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Enabled" })).toBeDisabled());
      expect(fetchMock).toHaveBeenCalledWith("/api/push/subscriptions", expect.objectContaining({ method: "POST" }));
    });

    it("drops one made with another key, so the device can enable again", async () => {
      const { unsubscribe } = existing(new Uint8Array([1, 2, 3]));
      render(<NotificationsSection vapidPublicKey="AAAA" />);
      await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
      expect(screen.getByRole("button", { name: "Enable on this device" })).toBeEnabled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends a test and says so", async () => {
      existing(new Uint8Array([0, 0, 0]));
      render(<NotificationsSection vapidPublicKey="AAAA" />);
      const button = await screen.findByRole("button", { name: "Send a test" });
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
      await userEvent.click(button);
      expect(fetchMock).toHaveBeenCalledWith("/api/push/test", { method: "POST" });
      expect(await screen.findByText(/It should arrive/)).toBeInTheDocument();
    });

    it("shows why a test did not send", async () => {
      existing(new Uint8Array([0, 0, 0]));
      render(<NotificationsSection vapidPublicKey="AAAA" />);
      const button = await screen.findByRole("button", { name: "Send a test" });
      fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Its VAPID keys are missing." }) });
      await userEvent.click(button);
      expect(await screen.findByRole("alert")).toHaveTextContent("VAPID keys are missing");
    });
  });
});
