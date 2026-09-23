import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as login } from "@/app/api/auth/github/login/route";
import { GET as callback } from "@/app/api/auth/github/callback/route";
import { repository } from "@/lib/db";
import { OAUTH_COOKIE, SESSION_COOKIE, verifySession } from "./session";
import { githubTokenFor, storeTokens } from "./github";
import { credentialsFor } from "./credentials";
import { resetEnvCache } from "@/lib/secrets/env";

const ORIGIN = "http://localhost:3000";

/** A stand-in for GitHub's token and user endpoints. */
function fakeGitHub(profile = { id: 42, login: "octo", name: "Octo Cat", avatar_url: null }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/login/oauth/access_token")) {
      const refreshing = String(init?.body).includes("refresh_token\"");
      return Response.json({
        access_token: refreshing ? "ghu_refreshed" : "ghu_first",
        expires_in: 28800,
        refresh_token: "ghr_refresh",
        refresh_token_expires_in: 15811200,
      });
    }
    if (url.endsWith("/user")) return Response.json(profile);
    return new Response("not found", { status: 404 });
  });
  return calls;
}

function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const [k, ...v] = pair!.split("=");
    out[k!] = v.join("=");
  }
  return out;
}

/** Runs the whole round trip: out to GitHub and back with a code. */
async function signIn(next = "/") {
  const out = await login(new Request(`${ORIGIN}/api/auth/github/login?next=${encodeURIComponent(next)}`));
  const state = new URL(out.headers.get("location")!).searchParams.get("state")!;
  const oauth = cookiesOf(out)[OAUTH_COOKIE]!;
  return callback(
    new Request(`${ORIGIN}/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `${OAUTH_COOKIE}=${oauth}` },
    }),
  );
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.test");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "shh");
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("FORMIC_ALLOWED_USERS", "");
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe("signing in with GitHub", () => {
  it("sends people to GitHub with a state only their browser can answer", async () => {
    const res = await login(new Request(`${ORIGIN}/api/auth/github/login?next=/settings`));
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(to.searchParams.get("client_id")).toBe("Iv1.test");
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/github/callback`);
    expect(cookiesOf(res)[OAUTH_COOKIE]).toContain(to.searchParams.get("state")!);
  });

  it("signs them in, keeps their token sealed, and returns them where they were", async () => {
    fakeGitHub();
    const res = await signIn("/settings");

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    const userId = await verifySession(cookiesOf(res)[SESSION_COOKIE]);
    const user = await repository().userById(userId!);
    expect(user).toMatchObject({ login: "octo", githubId: 42 });
    expect(user!.githubTokenCipher).not.toContain("ghu_first");
    expect(await githubTokenFor(user!)).toBe("ghu_first");
  });

  it("refuses a callback whose state does not match", async () => {
    fakeGitHub();
    const res = await callback(
      new Request(`${ORIGIN}/api/auth/github/callback?code=abc&state=forged`),
    );
    expect(res.headers.get("location")).toContain("/login?error=");
    expect(cookiesOf(res)[SESSION_COOKIE]).toBeUndefined();
  });

  it("keeps out anyone not on FORMIC_ALLOWED_USERS", async () => {
    vi.stubEnv("FORMIC_ALLOWED_USERS", "someone-else");
    fakeGitHub();
    const res = await signIn();
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toContain(
      "octo is not on",
    );
    expect(cookiesOf(res)[SESSION_COOKIE]).toBeUndefined();
  });

  it("gives the first person the boards made before accounts", async () => {
    const demo = await repository().defaultProject();
    fakeGitHub();
    const res = await signIn();
    const userId = await verifySession(cookiesOf(res)[SESSION_COOKIE]);
    expect((await repository().projectById(demo.id))?.ownerId).toBe(userId);
  });
});

describe("GitHub tokens", () => {
  it("refreshes a token about to expire, and keeps the new one", async () => {
    const calls = fakeGitHub();
    const user = await repository().upsertUser({ githubId: 7, login: "x", name: null, avatarUrl: null });
    await storeTokens(user.id, {
      accessToken: "ghu_old",
      expiresAt: new Date(Date.now() + 60_000),
      refreshToken: "ghr_refresh",
      refreshExpiresAt: new Date(Date.now() + 86_400_000),
    });

    const fresh = await repository().userById(user.id);
    expect(await githubTokenFor(fresh!)).toBe("ghu_refreshed");
    expect(calls.at(-1)?.body).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_refresh" });
    expect(await githubTokenFor((await repository().userById(user.id))!)).toBe("ghu_refreshed");
  });

  it("gives up when the refresh token has lapsed too", async () => {
    fakeGitHub();
    const user = await repository().upsertUser({ githubId: 8, login: "y", name: null, avatarUrl: null });
    await storeTokens(user.id, {
      accessToken: "ghu_old",
      expiresAt: new Date(Date.now() - 1000),
      refreshToken: "ghr_old",
      refreshExpiresAt: new Date(Date.now() - 1000),
    });
    expect(await githubTokenFor((await repository().userById(user.id))!)).toBeNull();
  });
});

describe("whose credentials a run uses", () => {
  it("never lends the server's GitHub token to a signed-in person", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_operator");
    resetEnvCache();
    const user = await repository().upsertUser({ githubId: 9, login: "z", name: null, avatarUrl: null });
    const creds = await credentialsFor(user);
    expect(creds.githubToken).toBeNull();
  });

  it("prefers a person's own E2B and Anthropic keys over the server's", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_server");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-server");
    resetEnvCache();
    const { seal } = await import("@/lib/secrets/vault");
    const user = await repository().upsertUser({ githubId: 10, login: "w", name: null, avatarUrl: null });
    await repository().updateUser(user.id, { e2bKeyCipher: seal("e2b_mine") });
    const creds = await credentialsFor((await repository().userById(user.id))!);
    expect(creds.e2bKey).toBe("e2b_mine");
    expect(creds.anthropicKey).toBe("sk-ant-server");
  });

  it("uses the server's GitHub token in local mode", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_TOKEN", "ghp_operator");
    resetEnvCache();
    expect((await credentialsFor(null)).githubToken).toBe("ghp_operator");
  });
});
