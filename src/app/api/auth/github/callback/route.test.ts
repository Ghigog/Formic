import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OAuth callback is where a stranger becomes a signed-in user, so it must
 * refuse a state it did not issue, refuse someone not on the list, and only
 * then set a session. GitHub itself is mocked; the cookie signing is real.
 */

const mocks = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  fetchProfile: vi.fn(),
  storeTokens: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/github", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...mocks,
}));

const { GET } = await import("./route");
const { repository } = await import("@/lib/db");
const { OAUTH_COOKIE, SESSION_COOKIE, readSession, signValue } = await import(
  "@/lib/auth/session"
);

const TOKENS = { accessToken: "gho_x", refreshToken: null, expiresAt: null, refreshExpiresAt: null };
const PROFILE = { githubId: 7, login: "octo", name: "Octo", avatarUrl: null };

async function callback(query: string, cookie?: string): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/auth/github/callback?${query}`, {
      headers: cookie ? { cookie: `${OAUTH_COOKIE}=${encodeURIComponent(cookie)}` } : {},
    }),
  );
}

function loginError(res: Response): string | null {
  const to = new URL(res.headers.get("location") ?? "");
  expect(to.pathname).toBe("/login");
  return to.searchParams.get("error");
}

beforeEach(() => {
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "id");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "secret");
  vi.stubEnv("FORMIC_SECRET", "s".repeat(32));
  mocks.exchangeCode.mockReset().mockResolvedValue(TOKENS);
  mocks.fetchProfile.mockReset().mockResolvedValue(PROFILE);
  mocks.storeTokens.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/auth/github/callback", () => {
  it("sends people home when GitHub sign-in is not configured", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");

    const res = await callback("code=c&state=s");

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/");
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it.each([["unset", ""], ["31 bytes", "s".repeat(31)]])(
    "refuses sign-in without a session or GitHub call when FORMIC_SECRET is %s",
    async (_name, secret) => {
      const cookie = await signValue("n1|/");
      vi.stubEnv("FORMIC_SECRET", secret);

      const res = await callback("code=c&state=n1", cookie);

      expect(res.status).toBe(303);
      expect(loginError(res)).toMatch(/FORMIC_SECRET/);
      expect(res.headers.get("set-cookie")).not.toContain(`${SESSION_COOKIE}=`);
      expect(mocks.exchangeCode).not.toHaveBeenCalled();
    },
  );

  it("refuses a state it did not sign, or one that does not match", async () => {
    const forged = await callback("code=c&state=n1", "n1|/.forged");
    const mismatched = await callback("code=c&state=other", await signValue("n1|/"));
    const missing = await callback("code=c&state=n1");

    for (const res of [forged, mismatched, missing]) {
      expect(res.status).toBe(303);
      expect(loginError(res)).toMatch(/expired/);
      expect(res.headers.get("set-cookie")).toContain(`${OAUTH_COOKIE}=;`);
    }
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it("shows GitHub's own failure rather than a session", async () => {
    mocks.exchangeCode.mockRejectedValue(new Error("The code expired."));

    const res = await callback("code=c&state=n1", await signValue("n1|/"));

    expect(loginError(res)).toBe("The code expired.");
    expect(res.headers.get("set-cookie")).not.toContain(SESSION_COOKIE);
  });

  it("refuses someone who is not on the allowed list", async () => {
    vi.stubEnv("FORMIC_ALLOWED_USERS", "someone-else");

    const res = await callback("code=c&state=n1", await signValue("n1|/"));

    expect(loginError(res)).toMatch(/octo is not on/);
    expect(mocks.storeTokens).not.toHaveBeenCalled();
  });

  it("signs an allowed person in, keeps their tokens and returns them where they were going", async () => {
    const res = await callback("code=c&state=n1", await signValue("n1|/board/3"));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/board/3");
    expect(mocks.exchangeCode).toHaveBeenCalledWith(
      "c",
      "http://localhost/api/auth/github/callback",
    );

    expect(mocks.storeTokens).toHaveBeenCalledWith(expect.any(String), TOKENS);
    const [userId] = mocks.storeTokens.mock.calls[0] as unknown as [string];
    const user = await repository().userById(userId);
    expect(user?.login).toBe("octo");

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const value = session.slice(SESSION_COOKIE.length + 1).split(";")[0];
    expect((await readSession(value))?.userId).toBe(user!.id);
    expect(cookies.some((c) => c.startsWith(`${OAUTH_COOKIE}=;`))).toBe(true);
  });

  it("never follows a next path off this site", async () => {
    const res = await callback("code=c&state=n1", await signValue("n1|//evil.example"));

    expect(res.headers.get("location")).toBe("/");
  });

  it("gives the first person to sign in the boards made before accounts existed, and only them", async () => {
    const repo = repository();
    vi.spyOn(repo, "countUsers").mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const adopt = vi.spyOn(repo, "adoptUnowned").mockResolvedValue(undefined);

    await callback("code=c&state=n1", await signValue("n1|/"));
    await callback("code=c&state=n2", await signValue("n2|/"));

    expect(adopt).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/auth/github/callback, connecting GitHub to a signed-in account", () => {

  async function connectCallback(state: string, opts: { as?: string; nonce?: string } = {}) {
    const session = await import("@/lib/auth/session");
    const cookies = [`${OAUTH_COOKIE}=${encodeURIComponent(await signValue(state))}`];
    if (opts.as) cookies.push(`${SESSION_COOKIE}=${await session.signSession(opts.as)}`);
    return GET(
      new Request(`http://localhost/api/auth/github/callback?code=c&state=${opts.nonce ?? "n1"}`, {
        headers: { cookie: cookies.join("; ") },
      }),
    );
  }

  beforeEach(() => {
    globalThis.__formicMemoryStore = undefined;
    vi.stubEnv("FORMIC_MAILER", "console");
  });

  it("attaches GitHub to the account that asked, and sets no new session", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    const res = await connectCallback(`n1|/settings|connect:${ana.id}`, { as: ana.id });

    expect(res.headers.get("location")).toBe("/settings");
    expect(res.headers.get("set-cookie")).not.toContain(`${SESSION_COOKIE}=`);
    expect(await repository().userById(ana.id)).toMatchObject({ githubId: 7, login: "octo", email: "ana@example.com" });
    expect(mocks.storeTokens).toHaveBeenCalledWith(ana.id, TOKENS);
    expect(await repository().countUsers()).toBe(1);
  });

  it("refuses when the signed-in person is not who started it", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    const bo = await repository().createEmailUser({ email: "bo@example.com", login: "bo" });
    const res = await connectCallback(`n1|/settings|connect:${ana.id}`, { as: bo.id });

    expect(new URL(res.headers.get("location")!).searchParams.get("github_error")).toContain("another session");
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect((await repository().userById(ana.id))?.githubId).toBeNull();
    expect((await repository().userById(bo.id))?.githubId).toBeNull();
  });

  it("refuses when nobody is signed in", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    const res = await connectCallback(`n1|/settings|connect:${ana.id}`);
    expect(new URL(res.headers.get("location")!).searchParams.get("github_error")).toBeTruthy();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a GitHub account already connected to someone else's email account, and revokes the new token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const octo = await repository().createEmailUser({ email: "octo@example.com", login: "octo" });
    await repository().linkGithub(octo.id, PROFILE);
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    const res = await connectCallback(`n1|/settings|connect:${ana.id}`, { as: ana.id });

    expect(new URL(res.headers.get("location")!).searchParams.get("github_error")).toContain("already connected");
    expect((await repository().userById(ana.id))?.githubId).toBeNull();
    expect((await repository().userById(octo.id))?.githubId).toBe(7);
    expect(mocks.storeTokens).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/applications/id/token"), expect.objectContaining({ method: "DELETE" }));
  });

  it("folds a new email account into the person's GitHub-only account, keeping its boards", async () => {
    const octo = await repository().upsertUser(PROFILE);
    const hers = await repository().ensureProject({ ownerId: octo.id, repoFullName: "octo/app", baseBranch: "main" });
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    const fresh = await repository().ensureProject({ ownerId: ana.id, repoFullName: null, name: "Notes", baseBranch: "main" });

    const res = await connectCallback(`n1|/settings|connect:${ana.id}`, { as: ana.id });

    expect(res.headers.get("location")).toBe("/settings?merged=1");
    expect((await readSession(cookieValue(res, SESSION_COOKIE)))?.userId).toBe(octo.id);
    expect(await repository().userById(ana.id)).toBeNull();
    expect(await repository().userById(octo.id)).toMatchObject({ githubId: 7, email: "ana@example.com" });
    expect((await repository().projectById(hers.id))?.ownerId).toBe(octo.id);
    expect((await repository().projectById(fresh.id))?.ownerId).toBe(octo.id);
    expect(mocks.storeTokens).toHaveBeenCalledWith(octo.id, TOKENS);
  });

  it("still signs in by GitHub to the email account it was connected to", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    await repository().linkGithub(ana.id, PROFILE);
    const res = await callback("code=c&state=n1", await signValue("n1|/"));
    expect((await readSession(cookieValue(res, SESSION_COOKIE)))?.userId).toBe(ana.id);
  });
});

function cookieValue(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [k, ...v] = pair!.split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
