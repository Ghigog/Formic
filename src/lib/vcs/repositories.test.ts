import { afterEach, describe, expect, it, vi } from "vitest";

import { createRepository } from "./repositories";

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
