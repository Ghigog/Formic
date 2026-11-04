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
  vi.stubEnv("FORMIC_SECRET", "s".repeat(32));
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

  it.each([["unset", ""], ["31 bytes", "s".repeat(31)]])(
    "refuses sign-in and sets no cookie when FORMIC_SECRET is %s",
    async (_name, secret) => {
      vi.stubEnv("FORMIC_SECRET", secret);
      const res = await login();
      expect(res.status).toBe(303);
      const to = new URL(res.headers.get("Location") ?? "");
      expect(to.pathname).toBe("/login");
      expect(to.searchParams.get("error")).toMatch(/FORMIC_SECRET/);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    },
  );

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

describe("GET /api/auth/github/login?intent=connect", () => {
  it("sends someone who isn't signed in to sign in first", async () => {
    const res = await login("?intent=connect");
    const to = new URL(res.headers.get("Location") ?? "");
    expect(to.pathname).toBe("/login");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("names the signed-in account in the signed state", async () => {
    globalThis.__formicMemoryStore = undefined;
    const { repository } = await import("@/lib/db");
    const { SESSION_COOKIE, signSession, verifyValue } = await import("@/lib/auth/session");
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    const res = await GET(
      new Request("http://localhost/api/auth/github/login?intent=connect", {
        headers: { "x-forwarded-for": "2.2.2.2", cookie: `${SESSION_COOKIE}=${await signSession(ana.id)}` },
      }),
    );
    expect(new URL(res.headers.get("Location") ?? "").origin).toBe("https://github.com");
    const raw = decodeURIComponent(res.headers.get("Set-Cookie")!.split(";")[0]!.split("=").slice(1).join("="));
    expect(await verifyValue(raw)).toMatch(new RegExp(`^[0-9a-f]{32}\\|/settings\\|connect:${ana.id}$`));
  });
});
