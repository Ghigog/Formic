import { afterEach, describe, expect, it, vi } from "vitest";

import { createRepository, listRepositories } from "./repositories";

afterEach(() => vi.unstubAllGlobals());

describe("createRepository", () => {
  it("creates a private repository with a first commit", async () => {
    let sent: unknown;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return Response.json(
        {
          full_name: "ada/fresh",
          default_branch: "main",
          private: true,
          description: null,
          pushed_at: null,
        },
        { status: 201 },
      );
    });
    const result = await createRepository("fresh", "tok");
    expect(sent).toEqual({ name: "fresh", private: true, auto_init: true });
    expect(result).toEqual({
      ok: true,
      repo: { fullName: "ada/fresh", defaultBranch: "main", private: true, description: null, pushedAt: null },
    });
  });

  it("explains a name that is taken and a missing permission", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 422 }));
    expect(await createRepository("fresh", "tok")).toEqual({
      ok: false,
      reason: "You already have a repository called fresh.",
    });
  });

  /** GitHub refuses the create, then describes the installation on ada's own account. */
  function refusedWith(installations: unknown[]) {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/user/repos")) {
        return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
      }
      if (url.endsWith("/user")) return Response.json({ login: "ada" });
      return Response.json({ installations });
    });
  }
  const install = (over: object) => ({
    account: { login: "Ada" },
    repository_selection: "all",
    permissions: { administration: "write" },
    ...over,
  });
  const reason = async () => {
    const r = await createRepository("fresh", "tok");
    return !r.ok && r.reason;
  };

  it("says when the app is not installed on the person's own account", async () => {
    refusedWith([install({ account: { login: "some-org" } })]);
    expect(await reason()).toMatch(/isn't installed on your own account \(ada\)/);
  });

  it("says when the installation has not accepted Administration", async () => {
    refusedWith([install({ permissions: { contents: "write" } })]);
    expect(await reason()).toMatch(/hasn't accepted the Administration permission/);
  });

  it("says when the installation only sees selected repositories", async () => {
    refusedWith([install({ repository_selection: "selected" })]);
    expect(await reason()).toMatch(/All repositories/);
  });

  it("passes on GitHub's own words when the installation looks right", async () => {
    refusedWith([install({})]);
    expect(await reason()).toMatch(/Resource not accessible by integration/);
  });
});

describe("listRepositories", () => {
  const raw = (full_name: string, pushed_at: string | null) => ({
    full_name,
    default_branch: "main",
    private: false,
    description: null,
    pushed_at,
  });

  it("maps a personal token's repositories", async () => {
    vi.stubGlobal("fetch", async () => Response.json([raw("ada/one", "2026-01-01T00:00:00Z")]));
    expect(await listRepositories("tok", "pat")).toEqual({
      ok: true,
      repos: [
        { fullName: "ada/one", defaultBranch: "main", private: false, description: null, pushedAt: "2026-01-01T00:00:00Z" },
      ],
    });
  });

  it("gathers an app token's installations, most recently pushed first", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/user/installations?")) return Response.json({ installations: [{ id: 1 }, { id: 2 }] });
      const repositories =
        url.includes("/installations/1/") ? [raw("ada/old", "2025-01-01T00:00:00Z")] : [raw("ada/new", "2026-01-01T00:00:00Z")];
      return Response.json({ repositories });
    });
    const result = await listRepositories("tok", "app");
    expect(result.ok && result.repos.map((r) => r.fullName)).toEqual(["ada/new", "ada/old"]);
  });

  it("gives the reason when GitHub refuses", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    expect(await listRepositories("tok", "pat")).toEqual({
      ok: false,
      reason: "GitHub refused the repository list (401).",
    });
  });
});
