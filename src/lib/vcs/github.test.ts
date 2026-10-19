import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubClient } from "./github";
import { MockVcsClient } from "./mock";

/**
 * The real GitHub adapter against a scripted `fetch`. The mock (`MockVcsClient`)
 * is what every other test runs against, so this pins the shapes the real
 * client returns to the same contract: the requests it makes, the fields it
 * reads, and the errors it raises.
 */

const REPO = "acme/widgets";
const RAW_PULL = {
  number: 7,
  html_url: "https://github.com/acme/widgets/pull/7",
  state: "open",
  merged: false,
  mergeable: true,
  title: "Add a retry button",
  head: { sha: "abc123", ref: "feature/retry" },
  base: { ref: "main" },
};

afterEach(() => vi.unstubAllGlobals());

/** A fetch that records what it was asked and answers from `handler`. */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}

function client() {
  return new GitHubClient(REPO, "token");
}

describe("GitHubClient", () => {
  it("opens a pull request with the right request and narrows the response", async () => {
    const calls = stubFetch(() => Response.json(RAW_PULL));

    const pull = await client().openPullRequest({
      headBranch: "feature/retry",
      baseBranch: "main",
      title: "Add a retry button",
      body: "body",
    });

    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      title: "Add a retry button",
      body: "body",
      head: "feature/retry",
      base: "main",
      maintainer_can_modify: true,
    });
    expect(pull).toEqual({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      headSha: "abc123",
      headBranch: "feature/retry",
      baseBranch: "main",
      state: "open",
      merged: false,
      mergeable: true,
      title: "Add a retry button",
    });
  });

  it("reads a pull request by number", async () => {
    const calls = stubFetch(() => Response.json(RAW_PULL));

    const pull = await client().pullRequest(7);

    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7");
    expect(calls[0]!.init.method).toBe("GET");
    expect(pull).toMatchObject({ number: 7, headSha: "abc123", merged: false });
  });

  it("merges with the head it was told, squashed", async () => {
    const calls = stubFetch(() => Response.json({ sha: "merge-sha", merged: true }));

    const out = await client().merge(7, "abc123");

    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/merge");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      sha: "abc123",
      merge_method: "squash",
    });
    expect(out).toEqual({ ok: true, sha: "merge-sha" });
  });

  it("turns a GitHub refusal into a VcsError carrying the status", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));

    await expect(client().pullRequest(9)).rejects.toMatchObject({
      name: "VcsError",
      status: 404,
    });
  });

  it("turns an unreachable GitHub into a VcsError rather than a bare fetch error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(client().pullRequest(9)).rejects.toMatchObject({ name: "VcsError" });
  });

  it("returns the same pull-request shape as the mock, so tests against the mock hold for GitHub", async () => {
    stubFetch(() => Response.json(RAW_PULL));
    const real = await client().openPullRequest({
      headBranch: "feature/retry",
      baseBranch: "main",
      title: "Add a retry button",
      body: "",
    });

    const mock = await new MockVcsClient(REPO).openPullRequest({
      headBranch: "feature/retry",
      baseBranch: "main",
      title: "Add a retry button",
      body: "",
    });

    // The mock carries an internal `checks` field beyond the shared contract;
    // strip it so the comparison is about the pull-request shape itself.
    expect(Object.keys(real).sort()).toEqual(
      Object.keys(mock).filter((k) => k !== "checks").sort(),
    );
  });

  it.each([405, 409])("reports a %i from merge as a conflict", async (status) => {
    const calls = stubFetch(() => new Response(JSON.stringify({ message: "nope" }), { status }));

    const out = await client().merge(7, "abc123");

    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, conflict: true });
  });

  it("does not report another merge refusal as a conflict", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 }));

    expect(await client().merge(7, "abc123")).toMatchObject({ ok: false, conflict: false });
  });

  it("updates a branch with PUT update-branch", async () => {
    const calls = stubFetch(() => Response.json({}, { status: 202 }));

    const out = await client().updateBranch(7);

    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/update-branch");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
    expect(out).toEqual({ ok: true, updated: true });
  });

  it("reads a 422 from updateBranch as a conflict only when the message says so", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "merge conflict between base and head" }), { status: 422 }));
    expect(await client().updateBranch(7)).toMatchObject({ ok: false, conflict: true });

    stubFetch(() => new Response(JSON.stringify({ message: "Validation failed" }), { status: 422 }));
    expect(await client().updateBranch(7)).toMatchObject({ ok: false, conflict: false });
  });

  it("rethrows other updateBranch failures", async () => {
    stubFetch(() => new Response(JSON.stringify({ message: "boom" }), { status: 500 }));

    await expect(client().updateBranch(7)).rejects.toMatchObject({ status: 500 });
  });

  describe("bringsInBase", () => {
    it("is true when the second parent is already on base", async () => {
      const calls = stubFetch((url) =>
        url.includes("/commits/")
          ? Response.json({ parents: [{ sha: "from" }, { sha: "other" }] })
          : Response.json({ status: "behind" }),
      );

      expect(await client().bringsInBase("from", "to", "feat/x")).toBe(true);
      expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/commits/to");
      expect(calls[1]!.url).toBe("https://api.github.com/repos/acme/widgets/compare/feat%2Fx...other");
      expect(calls[1]!.init.method).toBe("GET");
    });

    it("is false when the first parent is not `from`, without comparing", async () => {
      const calls = stubFetch(() => Response.json({ parents: [{ sha: "else" }, { sha: "other" }] }));

      expect(await client().bringsInBase("from", "to", "main")).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it("is false for a commit that is not a merge", async () => {
      stubFetch(() => Response.json({ parents: [{ sha: "from" }] }));

      expect(await client().bringsInBase("from", "to", "main")).toBe(false);
    });

    it("is false when the other parent is ahead of base", async () => {
      stubFetch((url) =>
        url.includes("/commits/")
          ? Response.json({ parents: [{ sha: "from" }, { sha: "other" }] })
          : Response.json({ status: "ahead" }),
      );

      expect(await client().bringsInBase("from", "to", "main")).toBe(false);
    });

    it("is false when GitHub refuses", async () => {
      stubFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));

      expect(await client().bringsInBase("from", "to", "main")).toBe(false);
    });
  });

  describe("mergeBranch", () => {
    it("posts the merge and reports a merge commit on 201", async () => {
      const calls = stubFetch(() => Response.json({ sha: "m" }, { status: 201 }));

      const out = await client().mergeBranch("main", "feat");

      expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/merges");
      expect(calls[0]!.init.method).toBe("POST");
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        base: "main",
        head: "feat",
        commit_message: "Bring feat into main",
      });
      expect(out).toEqual({ ok: true, updated: true });
    });

    it("reports nothing to merge on 204", async () => {
      stubFetch(() => new Response(null, { status: 204 }));

      expect(await client().mergeBranch("main", "feat")).toEqual({ ok: true, updated: false });
    });

    it("reports a 409 as a conflict", async () => {
      stubFetch(() => new Response(JSON.stringify({ message: "Merge conflict" }), { status: 409 }));

      expect(await client().mergeBranch("main", "feat")).toMatchObject({ ok: false, conflict: true });
    });

    it("rethrows other failures", async () => {
      stubFetch(() => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));

      await expect(client().mergeBranch("main", "feat")).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("landCarried", () => {
    const AUTHOR = { name: "A", email: "a@x", date: "2026-01-01T00:00:00Z" };

    /** A commit whose tree holds `deleted` as the CARRY_DELETED blob and one carried file. */
    function carryStub(deleted: string) {
      return stubFetch((url, init) => {
        const path = url.replace("https://api.github.com/repos/acme/widgets", "");
        if (path === "/git/commits/c1") {
          return Response.json({ message: "msg", tree: { sha: "t1" }, parents: [{ sha: "p1" }], author: AUTHOR });
        }
        if (path === "/git/trees/t1?recursive=1") {
          return Response.json({
            tree: [
              { path: ".formic/carry-deleted", mode: "100644", type: "blob", sha: "bd" },
              { path: ".formic/carry/.github/workflows/ci.yml", mode: "100644", type: "blob", sha: "bc" },
              { path: "src", mode: "040000", type: "tree", sha: "ts" },
            ],
          });
        }
        if (path === "/git/blobs/bd") {
          return Response.json({ content: Buffer.from(deleted).toString("base64") });
        }
        if (path === "/git/trees" && init.method === "POST") return Response.json({ sha: "t2" });
        if (path === "/git/commits" && init.method === "POST") return Response.json({ sha: "c2" });
        return new Response("{}", { status: 404 });
      });
    }

    it("sends exactly the listed deletions in the tree and commit", async () => {
      const calls = carryStub(".github/workflows/old.yml\n\n  .github/workflows/gone.yml  \n");

      const out = await client().landCarried("c1");

      expect(out).toEqual({
        sha: "c2",
        files: [".github/workflows/old.yml", ".github/workflows/gone.yml", ".github/workflows/ci.yml"],
      });
      const posts = calls.filter((c) => c.init.method === "POST");
      expect(posts.map((c) => c.url)).toEqual([
        "https://api.github.com/repos/acme/widgets/git/trees",
        "https://api.github.com/repos/acme/widgets/git/commits",
      ]);
      expect(JSON.parse(String(posts[0]!.init.body))).toEqual({
        base_tree: "t1",
        tree: [
          { path: ".formic/carry-deleted", mode: "100644", type: "blob", sha: null },
          { path: ".github/workflows/old.yml", mode: "100644", type: "blob", sha: null },
          { path: ".github/workflows/gone.yml", mode: "100644", type: "blob", sha: null },
          { path: ".formic/carry/.github/workflows/ci.yml", mode: "100644", type: "blob", sha: null },
          { path: ".github/workflows/ci.yml", mode: "100644", type: "blob", sha: "bc" },
        ],
      });
      expect(JSON.parse(String(posts[1]!.init.body))).toEqual({
        message: "msg",
        tree: "t2",
        parents: ["p1"],
        author: AUTHOR,
      });
    });

    it.each(["/etc/passwd", "../outside", ".github/../../x", ".formic/carry/x.yml"])(
      "refuses a deletion of %s before making any tree or commit",
      async (bad) => {
        const calls = carryStub(`.github/workflows/old.yml\n${bad}\n`);

        await expect(client().landCarried("c1")).rejects.toMatchObject({ name: "VcsError" });

        expect(calls.filter((c) => c.init.method === "POST")).toEqual([]);
      },
    );
  });

  describe("recordMerge", () => {
    it("commits the same tree with the merged commit added as a parent", async () => {
      const calls = stubFetch((url, init) =>
        init.method === "POST"
          ? Response.json({ sha: "m1" })
          : Response.json({
              message: "msg",
              tree: { sha: "t1" },
              parents: [{ sha: "p1" }],
              author: { name: "A", email: "a@x", date: "d" },
            }),
      );

      expect(await client().recordMerge("c1", "other")).toBe("m1");
      expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/git/commits/c1");
      expect(calls[1]!.url).toBe("https://api.github.com/repos/acme/widgets/git/commits");
      expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
        message: "msg",
        tree: "t1",
        parents: ["p1", "other"],
        author: { name: "A", email: "a@x", date: "d" },
      });
    });
  });

  describe("moveBranch", () => {
    it("fast-forwards an existing branch without force", async () => {
      const calls = stubFetch(() => Response.json({}));

      await client().moveBranch("feat/x", "s1");

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/widgets/git/refs/heads/feat%2Fx");
      expect(calls[0]!.init.method).toBe("PATCH");
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ sha: "s1", force: false });
    });

    it.each([404, 422])("creates the branch after a %i", async (status) => {
      const calls = stubFetch((_url, init) =>
        init.method === "PATCH"
          ? new Response(JSON.stringify({ message: "x" }), { status })
          : Response.json({}),
      );

      await client().moveBranch("feat/x", "s1");

      expect(calls[1]!.url).toBe("https://api.github.com/repos/acme/widgets/git/refs");
      expect(calls[1]!.init.method).toBe("POST");
      expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ ref: "refs/heads/feat/x", sha: "s1" });
    });

    it("rethrows other failures without creating", async () => {
      const calls = stubFetch(() => new Response(JSON.stringify({ message: "x" }), { status: 500 }));

      await expect(client().moveBranch("feat/x", "s1")).rejects.toMatchObject({ status: 500 });
      expect(calls).toHaveLength(1);
    });
  });
});
