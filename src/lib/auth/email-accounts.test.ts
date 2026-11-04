import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Someone who signed in by email and never connected GitHub: what they can
 * reach, and above all what they can't. Email sign-in alone turns on
 * accounts mode, with no GitHub App configured at all.
 */

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined) }),
}));

const { repository } = await import("@/lib/db");
const { SESSION_COOKIE, authMode, signSession } = await import("./session");
const { credentialsFor, credentialsForProject } = await import("./credentials");
const { currentUser } = await import("./user");
const { isGithubLinked, isUserAllowed } = await import("./github");
const { vcs, resetVcs, GitHubNotConnectedError } = await import("@/lib/vcs");
const { resetEnvCache } = await import("@/lib/secrets/env");

async function emailPerson(email: string, login = email.split("@")[0]!) {
  return repository().createEmailUser({ email, login });
}

async function actAs(userId: string) {
  jar.clear();
  jar.set(SESSION_COOKIE, await signSession(userId));
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
  vi.stubEnv("FORMIC_MAILER", "console");
  vi.stubEnv("FORMIC_SECRET", "x".repeat(32));
  // The operator's own credentials, which no account may ever borrow.
  vi.stubEnv("GITHUB_TOKEN", "ghp_operator");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-operator");
  vi.stubEnv("AGENT_PROVIDER", "");
  resetEnvCache();
  resetVcs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  resetVcs();
});

describe("accounts mode from email alone", () => {
  it("is on with email sign-in and no GitHub App", () => {
    expect(authMode()).toBe("accounts");
  });

  it("signs the person in by their session", async () => {
    const ana = await emailPerson("ana@example.com");
    await actAs(ana.id);
    expect((await currentUser())?.id).toBe(ana.id);
    expect(isGithubLinked(ana)).toBe(false);
  });
});

describe("an email account with no GitHub", () => {
  it("never gets the server's GitHub token", async () => {
    const ana = await emailPerson("ana@example.com");
    const creds = await credentialsFor(ana);
    expect(creds.githubToken).toBeNull();
    expect(creds.githubTokenKind).toBeNull();
  });

  it("never gets the server's GitHub token for a board it owns", async () => {
    const ana = await emailPerson("ana@example.com");
    const board = await repository().ensureProject({ ownerId: ana.id, repoFullName: "", baseBranch: "main" });
    expect((await credentialsForProject(board)).githubToken).toBeNull();
  });

  it("gets no GitHub token for an ownerless board either", async () => {
    expect((await credentialsFor(null)).githubToken).toBeNull();
  });

  it("gets a client that refuses, never the mock that would pretend", async () => {
    const client = vcs("ana/repo", null);
    expect(client.name).toBe("disconnected");
    await expect(client.pullRequest(1)).rejects.toBeInstanceOf(GitHubNotConnectedError);
    await expect(client.ensureBranch("b", "main")).rejects.toThrow("Connect GitHub");
  });

  it("still gets the mock with mock agents, which never reach GitHub", () => {
    vi.stubEnv("AGENT_PROVIDER", "mock");
    expect(vcs("ana/repo", null).name).toBe("mock");
  });
});

describe("the allow-list with email accounts", () => {
  it("lets anyone in when it is unset", async () => {
    vi.stubEnv("FORMIC_ALLOWED_USERS", "");
    expect(isUserAllowed(await emailPerson("ana@example.com"))).toBe(true);
  });

  it("matches an email address, ignoring case", async () => {
    vi.stubEnv("FORMIC_ALLOWED_USERS", "octo, Ana@Example.com");
    expect(isUserAllowed(await emailPerson("ana@example.com"))).toBe(true);
    expect(isUserAllowed(await emailPerson("bo@example.com"))).toBe(false);
  });

  it("does not let an email account in on a GitHub login it happens to share", async () => {
    vi.stubEnv("FORMIC_ALLOWED_USERS", "octo");
    const impostor = await emailPerson("octo@evil.example", "octo");
    expect(isUserAllowed(impostor)).toBe(false);
    await actAs(impostor.id);
    expect(await currentUser()).toBeNull();
  });

  it("still matches a connected GitHub login", async () => {
    vi.stubEnv("FORMIC_ALLOWED_USERS", "octo");
    const ana = await emailPerson("ana@example.com");
    const linked = await repository().linkGithub(ana.id, { githubId: 7, login: "octo", name: null, avatarUrl: null });
    expect(isUserAllowed(linked)).toBe(true);
  });
});

describe("linking and unlinking GitHub", () => {
  it("refuses a GitHub account that belongs to someone else", async () => {
    const ana = await emailPerson("ana@example.com");
    const bo = await emailPerson("bo@example.com");
    await repository().linkGithub(ana.id, { githubId: 7, login: "octo", name: null, avatarUrl: null });
    await expect(
      repository().linkGithub(bo.id, { githubId: 7, login: "octo", name: null, avatarUrl: null }),
    ).rejects.toThrow();
  });

  it("clears the GitHub id and every token on unlink", async () => {
    const ana = await emailPerson("ana@example.com");
    await repository().linkGithub(ana.id, { githubId: 7, login: "octo", name: null, avatarUrl: null });
    await repository().updateUser(ana.id, { githubTokenCipher: "c", githubRefreshCipher: "r" });
    const after = await repository().unlinkGithub(ana.id);
    expect(after).toMatchObject({ githubId: null, githubTokenCipher: null, githubRefreshCipher: null });
    expect(isGithubLinked(after)).toBe(false);
  });
});

describe("sign-in links", () => {
  const hash = "h".repeat(64);
  const later = (ms: number) => new Date(Date.now() + ms);

  it("spends once and only once", async () => {
    await repository().createLoginToken({ email: "Ana@Example.com", tokenHash: hash, next: "/", ip: null, expiresAt: later(60_000) });
    expect(await repository().spendLoginToken(hash, new Date())).toEqual({ email: "ana@example.com", next: "/" });
    expect(await repository().spendLoginToken(hash, new Date())).toBeNull();
  });

  it("does not spend after it expires", async () => {
    await repository().createLoginToken({ email: "ana@example.com", tokenHash: hash, next: "/", ip: null, expiresAt: later(-1) });
    expect(await repository().spendLoginToken(hash, new Date())).toBeNull();
  });

  it("counts links by address and by IP", async () => {
    const since = new Date(Date.now() - 1000);
    await repository().createLoginToken({ email: "ana@example.com", tokenHash: "a".repeat(64), next: "/", ip: "1.2.3.4", expiresAt: later(60_000) });
    await repository().createLoginToken({ email: "bo@example.com", tokenHash: "b".repeat(64), next: "/", ip: "1.2.3.4", expiresAt: later(60_000) });
    expect(await repository().countLoginTokens({ email: "ANA@example.com" }, since)).toBe(1);
    expect(await repository().countLoginTokens({ ip: "1.2.3.4" }, since)).toBe(2);
  });
});
