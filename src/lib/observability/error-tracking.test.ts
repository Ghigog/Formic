import { afterEach, describe, expect, it, vi } from "vitest";
import { trackError, trackThrown, resetSpikeTrackingForTests } from "./error-tracking";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSpikeTrackingForTests();
});

describe("trackError", () => {
  it("logs the route and commit alongside the error", () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const record = trackError({ message: "boom", route: "/api/tickets", source: "server" });

    expect(record.commit).toBe("abc123");
    expect(record.route).toBe("/api/tickets");
    const logged = JSON.parse(error.mock.calls[0]![1] as string);
    expect(logged.route).toBe("/api/tickets");
    expect(logged.commit).toBe("abc123");
  });

  it("redacts a secret out of the message and stack", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-ThisIsATestKeyValue0000");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const record = trackError({
      message: "call failed with sk-ant-api03-ThisIsATestKeyValue0000",
      stack: "Error: sk-ant-api03-ThisIsATestKeyValue0000\n at x",
      source: "server",
    });

    expect(record.message).not.toContain("sk-ant-api03-ThisIsATestKeyValue0000");
    expect(record.stack).not.toContain("sk-ant-api03-ThisIsATestKeyValue0000");
  });

  it("reports no commit when none is set", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const record = trackError({ message: "boom", source: "client" });
    expect(record.commit).toBeNull();
  });
});

describe("trackThrown", () => {
  it("pulls the message and stack out of a real Error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const record = trackThrown(new Error("route threw"), { route: "/api/health", source: "server" });
    expect(record.message).toBe("route threw");
    expect(record.route).toBe("/api/health");
  });

  it("stringifies a non-Error throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const record = trackThrown("just a string", { source: "server" });
    expect(record.message).toBe("just a string");
  });
});

describe("error spikes", () => {
  it("alerts once a burst of errors crosses the threshold, and not again immediately", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 10; i++) {
      trackError({ message: `error ${i}`, route: "/api/tickets", source: "server" });
    }
    // sendAlert is async; give its microtask a tick.
    await Promise.resolve();

    const alertCalls = warn.mock.calls.filter((c) => String(c[0]).includes("Error spike"));
    expect(alertCalls.length).toBe(1);

    trackError({ message: "one more", source: "server" });
    await Promise.resolve();
    const alertCallsAfter = warn.mock.calls.filter((c) => String(c[0]).includes("Error spike"));
    expect(alertCallsAfter.length).toBe(1);
  });

  it("does not alert below the threshold", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 3; i++) {
      trackError({ message: `error ${i}`, source: "server" });
    }
    await Promise.resolve();

    expect(warn.mock.calls.some((c) => String(c[0]).includes("Error spike"))).toBe(false);
  });
});
