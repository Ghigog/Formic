import { afterEach, describe, expect, it, vi } from "vitest";
import { ALERT_TIMEOUT_MS, sendAlert } from "./alerts";
import { resetEnvCache } from "@/lib/secrets/env";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCache();
  vi.restoreAllMocks();
});

describe("sendAlert", () => {
  it("logs instead of throwing when no webhook is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendAlert("something broke");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("something broke"));
  });

  it("posts the message to the configured webhook", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.com/incoming");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendAlert("db is down");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.example.com/incoming",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.text).toBe("db is down");
  });

  it("redacts a secret before it reaches the webhook or the log", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_SuperSecretTokenValue1234567890");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendAlert("failed using ghp_SuperSecretTokenValue1234567890");

    expect(warn.mock.calls[0]![0]).not.toContain("ghp_SuperSecretTokenValue1234567890");
    expect(warn.mock.calls[0]![0]).toContain("[redacted]");
  });

  it("does not throw when the webhook request fails", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.com/incoming");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendAlert("oops")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("gives up on a webhook that never responds and logs the alert", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example.com/incoming");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    // Only rejects when its signal aborts, like a real hung connection.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
          }),
      ),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Real 5s timer is shortened so the test stays fast.
    timeout.mockImplementation((ms) => {
      expect(ms).toBe(ALERT_TIMEOUT_MS);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 0);
      return controller.signal;
    });

    await expect(sendAlert("db is down")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "[formic] alert webhook timed out after 5s -- alert was: db is down",
    );
  });
});
