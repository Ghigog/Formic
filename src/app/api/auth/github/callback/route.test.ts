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
