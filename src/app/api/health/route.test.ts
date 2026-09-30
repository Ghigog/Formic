import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { resetEnvCache } from "@/lib/secrets/env";
import {
  SESSION_COOKIE,
  passwordToken,
  signSession,
  signingSecret,
} from "@/lib/auth/session";
import { createHmac } from "node:crypto";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

/** A request carrying the local password gate's session cookie. */
async function withPasswordCookie(req: Request): Promise<Request> {
  const headers = new Headers(req.headers);
  headers.append("cookie", `${SESSION_COOKIE}=${await passwordToken("right-password")}`);
  return new Request(req.url, { headers });
}

describe("/api/health", () => {
  it("tells a stranger only ok, commit and database", async () => {
    const res = await GET(new Request("http://localhost/api/health"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["commit", "database", "ok"]);
    expect(body.ok).toBe(true);
    expect(body.database).toBe("memory");
  });

  it("tells a stranger only ok, commit and database even when the report is bad", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    const res = await GET(new Request("http://localhost/api/health"));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["commit", "database", "ok"]);
  });

  it("gives the full report to the local password gate's session", async () => {
    vi.stubEnv("FORMIC_PASSWORD", "right-password");
    const res = await GET(
      await withPasswordCookie(new Request("http://localhost/api/health")),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.access).toBe("password");
    expect(body.warnings).toBeDefined();
  });

  it("gives the full report to a GitHub session", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    vi.stubEnv("FORMIC_SECRET", "a".repeat(32));
    const res = await GET(
      new Request("http://localhost/api/health", {
        headers: { cookie: `${SESSION_COOKIE}=${await signSession("user_1")}` },
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.access).toBe("github");
    expect(body.warnings).toEqual([]);
  });

  it("gives the full report to a runner's one-job token", async () => {
    const job = "job_1";
    const since = "1700000000000";
    const token = createHmac("sha256", signingSecret())
      .update(`runner-report:${job}:${since}`)
      .digest("hex");
    const res = await GET(
      new Request(`http://localhost/api/health?job=${job}&since=${since}&token=${token}`),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.buildId).toBeDefined();
  });

  it("keeps a forged session on the minimal report", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    vi.stubEnv("FORMIC_SECRET", "a".repeat(32));
    const res = await GET(
      new Request("http://localhost/api/health", {
        headers: { cookie: `${SESSION_COOKIE}=user_1.9999999999.deadbeef` },
      }),
    );
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["commit", "database", "ok"]);
  });

  it("reports ok: false in GitHub mode with no FORMIC_SECRET, to the operator", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    const res = await GET(
      new Request("http://localhost/api/health", {
        headers: { cookie: `${SESSION_COOKIE}=${await signSession("user_1")}` },
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.warnings).toContainEqual(expect.stringMatching(/FORMIC_SECRET is not set/));
  });

  it("is ok in GitHub mode with a FORMIC_SECRET of at least 32 bytes, to the operator", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
    vi.stubEnv("FORMIC_SECRET", "a".repeat(32));
    const res = await GET(
      new Request("http://localhost/api/health", {
        headers: { cookie: `${SESSION_COOKIE}=${await signSession("user_1")}` },
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
