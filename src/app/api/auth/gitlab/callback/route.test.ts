import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Connecting GitLab attaches a gitlab.com account to the person who started
 * it, and to no one else. It never signs anyone in. GitLab itself is mocked;
 * the cookie signing is real.
 */

const mocks = vi.hoisted(() => ({
  exchangeGitlabCode: vi.fn(),
  fetchGitlabAccount: vi.fn(),
  storeGitlabTokens: vi.fn(async () => undefined),
  revokeGitlabToken: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/gitlab", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...mocks,
}));

const { GET } = await import("./route");
const { repository } = await import("@/lib/db");
const { OAUTH_COOKIE, SESSION_COOKIE, signSession, signValue } = await import("@/lib/auth/session");

const TOKENS = { accessToken: "glpat_x", refreshToken: "r1", expiresAt: null };

async function callback(state: string, opts: { as?: string; nonce?: string } = {}) {
  const cookies = [`${OAUTH_COOKIE}=${encodeURIComponent(await signValue(state))}`];
  if (opts.as) cookies.push(`${SESSION_COOKIE}=${await signSession(opts.as)}`);
  return GET(
    new Request(`http://localhost/api/auth/gitlab/callback?code=c&state=${opts.nonce ?? "n1"}`, {
      headers: { cookie: cookies.join("; ") },
    }),
  );
}

function landing(res: Response): URL {
  expect(res.status).toBe(303);
  const to = new URL(res.headers.get("location")!);
  expect(to.pathname).toBe("/settings");
  return to;
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("GITLAB_CLIENT_ID", "id");
  vi.stubEnv("GITLAB_CLIENT_SECRET", "secret");
  vi.stubEnv("FORMIC_SECRET", "s".repeat(32));
  vi.stubEnv("FORMIC_MAILER", "console");
  mocks.exchangeGitlabCode.mockReset().mockResolvedValue(TOKENS);
  mocks.fetchGitlabAccount.mockReset().mockResolvedValue({ gitlabId: 77, login: "ana-gl" });
  mocks.storeGitlabTokens.mockClear();
  mocks.revokeGitlabToken.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/auth/gitlab/callback", () => {
  it("attaches GitLab to the account that asked, and sets no session", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });

    const res = await callback(`n1|gitlab-connect:${ana.id}`, { as: ana.id });

    expect(landing(res).searchParams.get("gitlab")).toBe("connected");
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    const after = await repository().userById(ana.id);
    expect(after).toMatchObject({ gitlabId: 77, gitlabLogin: "ana-gl" });
    expect(mocks.storeGitlabTokens).toHaveBeenCalledWith(ana.id, TOKENS);
  });

  it("refuses when someone else is signed in than started it", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    const bo = await repository().createEmailUser({ email: "bo@example.com", login: "bo" });

    const res = await callback(`n1|gitlab-connect:${ana.id}`, { as: bo.id });

    expect(landing(res).searchParams.get("gitlab_error")).toContain("another session");
    expect(mocks.exchangeGitlabCode).not.toHaveBeenCalled();
    expect((await repository().userById(bo.id))?.gitlabId).toBeNull();
  });

  it("refuses a state it did not issue", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });

    const res = await callback(`n1|gitlab-connect:${ana.id}`, { as: ana.id, nonce: "other" });

    expect(landing(res).searchParams.get("gitlab_error")).toContain("expired");
    expect(mocks.exchangeGitlabCode).not.toHaveBeenCalled();
  });

  it("refuses a GitLab account already connected to someone else, and revokes the new token", async () => {
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });
    const bo = await repository().createEmailUser({ email: "bo@example.com", login: "bo" });
    await repository().linkGitlab(bo.id, { gitlabId: 77, login: "ana-gl" });

    const res = await callback(`n1|gitlab-connect:${ana.id}`, { as: ana.id });

    expect(landing(res).searchParams.get("gitlab_error")).toContain("already connected");
    expect(mocks.revokeGitlabToken).toHaveBeenCalledWith("glpat_x");
    expect((await repository().userById(ana.id))?.gitlabId).toBeNull();
  });

  it("says so when this Formic has no GitLab application", async () => {
    vi.stubEnv("GITLAB_CLIENT_ID", "");
    const ana = await repository().createEmailUser({ email: "ana@example.com", login: "ana" });

    const res = await callback(`n1|gitlab-connect:${ana.id}`, { as: ana.id });

    expect(landing(res).searchParams.get("gitlab_error")).toContain("isn't set up");
  });
});
