import { afterEach, describe, expect, it, vi } from "vitest";
import { trackError, trackThrown, resetSpikeTrackingForTests } from "./error-tracking";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSpikeTrackingForTests();
});

describe("trackError", () => {
  it("logs the route and commit alongside the error", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc123");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const record = await trackError({ message: "boom", route: "/api/tickets", source: "server" });

    expect(record.commit).toBe("abc123");
    expect(record.route).toBe("/api/tickets");
    const logged = JSON.parse(error.mock.calls[0]![1] as string);
    expect(logged.route).toBe("/api/tickets");
    expect(logged.commit).toBe("abc123");
  });

  it("redacts a secret out of the message and stack", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-ThisIsATestKeyValue0000");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const record = await trackError({
      message: "call failed with sk-ant-api03-ThisIsATestKeyValue0000",
      stack: "Error: sk-ant-api03-ThisIsATestKeyValue0000\n at x",
      source: "server",
    });

    expect(record.message).not.toContain("sk-ant-api03-ThisIsATestKeyValue0000");
    expect(record.stack).not.toContain("sk-ant-api03-ThisIsATestKeyValue0000");
  });

  it("reports no commit when none is set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const record = await trackError({ message: "boom", source: "client" });
    expect(record.commit).toBeNull();
  });
});

describe("trackThrown", () => {
  it("pulls the message and stack out of a real Error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const record = await trackThrown(new Error("route threw"), { route: "/api/health", source: "server" });
    expect(record.message).toBe("route threw");
    expect(record.route).toBe("/api/health");
  });

  it("stringifies a non-Error throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const record = await trackThrown("just a string", { source: "server" });
    expect(record.message).toBe("just a string");
  });
});

describe("error spikes", () => {
  const spikeAlerts = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("Error spike"));

  it("alerts once for ten errors split across two instances, and not again within the cooldown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("FORMIC_URL", "https://board.test");
    vi.stubEnv("FORMIC_COMMIT", "abc123");

    // The memory store is process-global, so a fresh module graph stands in
    // for another instance sharing the same database.
    for (let instance = 0; instance < 2; instance++) {
      vi.resetModules();
      const fresh = await import("./error-tracking");
      for (let i = 0; i < 5; i++) {
        await fresh.trackError({ message: `error ${i}`, route: "/api/tickets", source: "server" });
      }
    }
    expect(spikeAlerts(warn)).toHaveLength(1);
    const text = String(spikeAlerts(warn)[0]![0]);
    expect(text).toContain("Error spike on https://board.test: 10 errors in the last 5 minutes on commit abc123");
    expect(text).toContain("Latest on /api/tickets: error 4. Playbook: ");

    await trackError({ message: "eleventh", source: "server" });
    expect(spikeAlerts(warn)).toHaveLength(1);
  });

  it("resolves only after the alert has been sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.test/x");
    let finish!: () => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (finish = () => resolve(new Response("ok")))),
    );
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 9; i++) await trackError({ message: `e${i}`, source: "server" });
    let done = false;
    const tenth = trackError({ message: "e9", source: "server" }).then(() => (done = true));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(done).toBe(false);
    finish();
    await tenth;
    expect(done).toBe(true);
    vi.unstubAllGlobals();
  });

  it("does not alert below the threshold", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await trackError({ message: `error ${i}`, source: "server" });
    expect(spikeAlerts(warn)).toHaveLength(0);
  });

  it("still logs and resolves when the repository fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = await import("@/lib/db");
    vi.spyOn(db, "repository").mockImplementation(() => {
      throw new Error("database down");
    });
    const record = await trackError({ message: "boom", source: "server" });
    expect(record.message).toBe("boom");
    expect(error.mock.calls[0]![0]).toBe("[formic:error]");
  });
});
