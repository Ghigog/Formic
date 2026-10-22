import { beforeEach, describe, expect, it, vi } from "vitest";

const { resetEnvCache } = await import("@/lib/secrets/env");
const { clearBuckets } = await import("@/lib/rate-limit");
const { OAUTH_COOKIE } = await import("@/lib/auth/session");
const { GET } = await import("./route");

const login = (query = "", ip = "1.1.1.1") =>
  GET(new Request(`http://localhost/api/auth/github/login${query}`, { headers: { "x-forwarded-for": ip } }));

beforeEach(() => {
  clearBuckets();
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("FORMIC_URL", "");
  resetEnvCache();
});

describe("GET /api/auth/github/login", () => {
  it("redirects to GitHub with a state and sets the matching cookie", async () => {
    const res = await login("?next=/board");
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("Iv1.test");
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost/api/auth/github/callback");
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers.get("Set-Cookie")).toContain(`${OAUTH_COOKIE}=`);
  });

  it("sends people home when no GitHub App is configured", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    const res = await login();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("http://localhost/");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("answers 429 after ten sign-ins a minute from one address", async () => {
    for (let i = 0; i < 10; i++) expect((await login()).status).toBe(303);
    expect((await login()).status).toBe(429);
    expect((await login("", "2.2.2.2")).status).toBe(303);
  });
});
