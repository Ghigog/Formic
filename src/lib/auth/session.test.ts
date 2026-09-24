import { afterEach, describe, expect, it, vi } from "vitest";
import { safeNext, secretProblem, signSession, signValue, verifySession, verifyValue } from "./session";

afterEach(() => vi.unstubAllEnvs());

describe("sessions", () => {
  it("names the user it was signed for", async () => {
    vi.stubEnv("FORMIC_SECRET", "s");
    expect(await verifySession(await signSession("user_1"))).toBe("user_1");
  });

  it("rejects a cookie edited to name someone else", async () => {
    vi.stubEnv("FORMIC_SECRET", "s");
    const cookie = await signSession("user_1");
    expect(await verifySession(cookie.replace("user_1", "user_2"))).toBeNull();
  });

  it("rejects a cookie signed under another secret", async () => {
    vi.stubEnv("FORMIC_SECRET", "s");
    const cookie = await signSession("user_1");
    vi.stubEnv("FORMIC_SECRET", "rotated");
    expect(await verifySession(cookie)).toBeNull();
  });

  it("expires after thirty days", async () => {
    vi.stubEnv("FORMIC_SECRET", "s");
    const now = Date.now();
    const cookie = await signSession("user_1", now);
    expect(await verifySession(cookie, now + 29 * 86_400_000)).toBe("user_1");
    expect(await verifySession(cookie, now + 31 * 86_400_000)).toBeNull();
  });

  it("rejects junk", async () => {
    for (const junk of [undefined, "", "a.b", "a.notanumber.c", "a.1.b.c"]) {
      expect(await verifySession(junk)).toBeNull();
    }
  });

  it("signs short values for the OAuth round trip", async () => {
    const signed = await signValue("nonce|/next");
    expect(await verifyValue(signed)).toBe("nonce|/next");
    expect(await verifyValue(signed.replace("/next", "/evil"))).toBeNull();
  });

  it("only sends people back to this site", () => {
    expect(safeNext("/settings")).toBe("/settings");
    expect(safeNext("//evil.com")).toBe("/");
    expect(safeNext("https://evil.com")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
});

describe("secretProblem", () => {
  function stubGithubMode() {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  }

  it("never objects in local mode, even with no secret at all", () => {
    expect(secretProblem()).toBeNull();
  });

  it("refuses GitHub mode with no FORMIC_SECRET", () => {
    stubGithubMode();
    expect(secretProblem()).toMatch(/FORMIC_SECRET is not set/);
  });

  it("refuses GitHub mode with a FORMIC_SECRET shorter than 32 bytes", () => {
    stubGithubMode();
    vi.stubEnv("FORMIC_SECRET", "short");
    expect(secretProblem()).toMatch(/shorter than 32 bytes/);
  });

  it("accepts GitHub mode with a FORMIC_SECRET of at least 32 bytes", () => {
    stubGithubMode();
    vi.stubEnv("FORMIC_SECRET", "a".repeat(32));
    expect(secretProblem()).toBeNull();
  });
});
