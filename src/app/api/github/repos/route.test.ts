import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUser, credentialsFor, listRepositories, createRepository, authMode } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  credentialsFor: vi.fn(),
  listRepositories: vi.fn(),
  createRepository: vi.fn(),
  authMode: vi.fn(),
}));

vi.mock("@/lib/auth/user", () => ({ currentUser }));
vi.mock("@/lib/auth/credentials", () => ({ credentialsFor }));
vi.mock("@/lib/auth/github", () => ({ installUrl: () => "https://github.com/apps/formic" }));
vi.mock("@/lib/auth/session", () => ({ authMode }));
vi.mock("@/lib/vcs/repositories", async (orig) => ({
  ...(await orig<typeof import("@/lib/vcs/repositories")>()),
  listRepositories,
  createRepository,
}));

const { GET, POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/github/repos", { method: "POST", body: JSON.stringify(body) }) as never);

beforeEach(() => {
  clearBuckets();
  currentUser.mockReset().mockResolvedValue({ id: "u1" });
  credentialsFor.mockReset().mockResolvedValue({ githubToken: "tok", githubTokenKind: "user" });
  authMode.mockReset().mockReturnValue("local");
  listRepositories.mockReset().mockResolvedValue({ ok: true, repos: [{ fullName: "a/b" }] });
  createRepository.mockReset().mockResolvedValue({ ok: true, repo: { fullName: "a/new" } });
});

describe("GET /api/github/repos", () => {
  it("lists repositories with the install url", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      repos: [{ fullName: "a/b" }],
      installUrl: "https://github.com/apps/formic",
    });
    expect(listRepositories).toHaveBeenCalledWith("tok", "user");
  });

  it("answers 401 when signed out", async () => {
    currentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("says to set GITHUB_TOKEN when there is no token locally", async () => {
    credentialsFor.mockResolvedValue({});
    const body = await (await GET()).json();
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("GITHUB_TOKEN");
    expect(listRepositories).not.toHaveBeenCalled();
  });

  it("says the sign-in lapsed in github mode", async () => {
    authMode.mockReturnValue("github");
    credentialsFor.mockResolvedValue({});
    expect((await (await GET()).json()).reason).toContain("lapsed");
  });
});

describe("POST /api/github/repos", () => {
  it("creates a repository", async () => {
    const res = await post({ name: "new" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repo: { fullName: "a/new" } });
    expect(createRepository).toHaveBeenCalledWith("new", "tok");
  });

  it("answers 401 when signed out", async () => {
    currentUser.mockResolvedValue(null);
    expect((await post({ name: "new" })).status).toBe(401);
  });

  it("answers 400 for a bad name", async () => {
    expect((await post({ name: "no spaces" })).status).toBe(400);
    expect(createRepository).not.toHaveBeenCalled();
  });

  it("answers 400 without a token", async () => {
    credentialsFor.mockResolvedValue({});
    expect((await post({ name: "new" })).status).toBe(400);
  });

  it("answers 422 when GitHub refuses", async () => {
    createRepository.mockResolvedValue({ ok: false, reason: "Name taken." });
    const res = await post({ name: "new" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Name taken." });
  });
});
