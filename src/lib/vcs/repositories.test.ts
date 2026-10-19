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
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 403 }));
    const denied = await createRepository("fresh", "tok");
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.reason).toMatch(/updated permissions/);
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
