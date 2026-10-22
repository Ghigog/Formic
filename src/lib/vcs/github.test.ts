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

  describe("hasCi", () => {
    function repoWith(files: Record<string, string>) {
      return stubFetch((url) => {
        if (url.includes("/actions/workflows")) {
          return Response.json({
            workflows: [
              { path: ".github/workflows/formic-agent.yml", state: "active" },
              ...Object.keys(files).map((path) => ({ path, state: "active" })),
            ],
          });
        }
        if (url.includes("/branches/")) return Response.json({});
        const path = Object.keys(files).find((p) => url.includes(p.split("/").map(encodeURIComponent).join("/")));
        if (path) return Response.json({ content: Buffer.from(files[path]!).toString("base64") });
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      });
    }

    it("is false when the only other workflow never runs on a pull request", async () => {
      repoWith({ ".github/workflows/build-apk.yml": "on:\n  workflow_dispatch:\n  push:\n    branches: [main]\n" });
      expect(await client().hasCi("main")).toBe(false);
    });

    it("is true when a workflow runs on pull requests", async () => {
      const calls = repoWith({
        ".github/workflows/build-apk.yml": "on:\n  push:\n    branches: [main]\n",
        ".github/workflows/ci.yml": "on: [pull_request]\n",
      });
      expect(await client().hasCi("main")).toBe(true);
      expect(calls.some((c) => c.url.includes("formic-agent.yml"))).toBe(false);
    });

    it("is true when a workflow cannot be read", async () => {
      stubFetch((url) => {
        if (url.includes("/actions/workflows")) {
          return Response.json({ workflows: [{ path: ".github/workflows/ci.yml", state: "active" }] });
        }
        if (url.includes("/branches/")) return Response.json({});
        return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
      });
      expect(await client().hasCi("main")).toBe(true);
    });
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

/** Answers by `"METHOD /path-after-the-repo"`; anything unlisted is a 404. */
function route(table: Record<string, unknown | ((init: RequestInit) => Response)>) {
  return stubFetch((url, init) => {
    const key = `${init.method ?? "GET"} ${url.replace("https://api.github.com/repos/acme/widgets", "")}`;
    const hit = table[key];
    if (hit === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return typeof hit === "function" ? (hit as (i: RequestInit) => Response)(init) : Response.json(hit);
  });
}

function fail(status: number, message = "nope") {
  return () => new Response(JSON.stringify({ message }), { status });
}

describe("GitHubClient: reads and writes", () => {
  it("ensureBranch leaves an existing branch alone", async () => {
    const calls = route({ "GET /git/ref/heads/feat": { object: { sha: "s" } } });
    await client().ensureBranch("feat", "main");
    expect(calls).toHaveLength(1);
  });

  it("ensureBranch creates a missing branch from the source ref's sha", async () => {
    const calls = route({
      "GET /git/ref/heads/main": { object: { sha: "m1" } },
      "POST /git/refs": {},
    });
    await client().ensureBranch("feat", "main");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ ref: "refs/heads/feat", sha: "m1" });
  });

  it("ensureBranch rethrows a non-404 failure", async () => {
    route({ "GET /git/ref/heads/feat": fail(500) });
    await expect(client().ensureBranch("feat", "main")).rejects.toMatchObject({ status: 500 });
  });

  it("checksFor narrows check runs", async () => {
    route({
      "GET /commits/abc/check-runs?per_page=100": {
        check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success", details_url: null, extra: 1 }],
      },
    });
    expect(await client().checksFor("abc")).toEqual([
      { id: 1, name: "ci", status: "completed", conclusion: "success", detailsUrl: null },
    ]);
  });

  describe("checkLog", () => {
    const RUN = { name: "ci", output: { title: "T", summary: null, text: "body" } };

    it("joins the output and maps annotations", async () => {
      route({
        "GET /check-runs/5": RUN,
        "GET /check-runs/5/annotations?per_page=50": [{ path: "a.ts", start_line: 3, message: "bad" }],
      });
      expect(await client().checkLog(5)).toEqual({
        name: "ci",
        summary: "T\n\nbody",
        annotations: [{ path: "a.ts", line: 3, message: "bad" }],
      });
    });

    it("treats unreadable annotations and a missing output as empty", async () => {
      route({
        "GET /check-runs/5": { name: "ci" },
        "GET /check-runs/5/annotations?per_page=50": fail(500),
      });
      expect(await client().checkLog(5)).toEqual({ name: "ci", summary: "", annotations: [] });
    });

    it("adds the end of an Actions job's log, before its cleanup", async () => {
      const log = [
        "2026-10-22T13:32:33.9523621Z OverlayShellStateTest > theTypePillStepsThroughTheTypes FAILED",
        "2026-10-22T13:32:40.3134444Z \u001b[31m##[error]Process completed with exit code 1.\u001b[0m",
        "2026-10-22T13:32:40.3335823Z Post job cleanup.",
        "2026-10-22T13:32:41.0139885Z Cleaning up orphan processes",
      ].join("\n");
      route({
        "GET /check-runs/5": RUN,
        "GET /check-runs/5/annotations?per_page=50": [],
        "GET /actions/jobs/5/logs": () => new Response(log),
      });
      expect((await client().checkLog(5)).summary).toBe(
        "T\n\nbody\n\nEnd of the job's log:\n" +
          "OverlayShellStateTest > theTypePillStepsThroughTheTypes FAILED\n" +
          "##[error]Process completed with exit code 1.",
      );
    });

    it("caps the summary", async () => {
      route({
        "GET /check-runs/5": { name: "ci", output: { title: null, summary: null, text: "x".repeat(30_000) } },
        "GET /check-runs/5/annotations?per_page=50": [],
      });
      expect((await client().checkLog(5)).summary).toHaveLength(20_000);
    });
  });

  it("retargets a pull request", async () => {
    const calls = route({ "PATCH /pulls/7": {} });
    await client().retargetPullRequest(7, "dev");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ base: "dev" });
  });

  describe("merge", () => {
    it("returns the merge sha", async () => {
      route({ "PUT /pulls/7/merge": { sha: "m", merged: true } });
      expect(await client().merge(7, "h")).toEqual({ ok: true, sha: "m" });
    });

    it("reports a declined merge", async () => {
      route({ "PUT /pulls/7/merge": { sha: "", merged: false } });
      expect(await client().merge(7, "h")).toMatchObject({ ok: false, conflict: false });
    });

    it.each([405, 409])("reads %i as a conflict", async (status) => {
      route({ "PUT /pulls/7/merge": fail(status) });
      expect(await client().merge(7, "h")).toMatchObject({ ok: false, conflict: true });
    });

    it("rethrows an unreachable GitHub", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("boom");
      });
      // An unreachable GitHub is a VcsError, so it is reported, not thrown.
      expect(await client().merge(7, "h")).toMatchObject({ ok: false, conflict: false });
    });
  });

  it("updateBranch reports a conflict-free 422 as not a conflict", async () => {
    route({ "PUT /pulls/7/update-branch": fail(422, "already up to date") });
    expect(await client().updateBranch(7)).toMatchObject({ ok: false, conflict: false });
  });

  it("comments, creates and updates issues", async () => {
    const calls = route({
      "POST /issues/7/comments": {},
      "POST /issues": { number: 9, id: 99, html_url: "u" },
      "PATCH /issues/9": {},
      "POST /issues/9/sub_issues": {},
    });
    const c = client();
    await c.comment(7, "hi");
    expect(await c.createIssue({ title: "t", body: "b", labels: ["l"] })).toEqual({ number: 9, id: 99, url: "u" });
    await c.updateIssue(9, { state: "closed" } as never);
    await c.addSubIssue(9, 5);
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ sub_issue_id: 5 });
  });

  describe("issues", () => {
    const RAW = (n: number, extra: object = {}) => ({
      number: n,
      id: n * 10,
      title: `t${n}`,
      body: null,
      state: "open",
      labels: ["a", { name: "b" }, {}],
      ...extra,
    });

    it("filters pull requests and sends the filter", async () => {
      const calls = route({
        "GET /issues?state=open&per_page=100&labels=a%2Cb&since=2024-01-01": [
          RAW(1),
          RAW(2, { pull_request: {} }),
          RAW(3, { parent_issue_url: "x" }),
        ],
      });
      const list = await client().issues("open", { labels: ["a", "b"], since: "2024-01-01" });
      expect(calls).toHaveLength(1);
      expect(list.map((i) => i.number)).toEqual([1, 3]);
      expect(list[0]!.labels).toEqual(["a", "b"]);
      expect(list[1]!.subIssue).toBe(true);
    });

    it("issue returns null for a pull request or a 404, and rethrows others", async () => {
      route({
        "GET /issues/1": RAW(1),
        "GET /issues/2": RAW(2, { pull_request: {} }),
        "GET /issues/4": fail(500),
      });
      const c = client();
      expect((await c.issue(1))?.number).toBe(1);
      expect(await c.issue(2)).toBeNull();
      expect(await c.issue(3)).toBeNull();
      await expect(c.issue(4)).rejects.toMatchObject({ status: 500 });
    });
  });

  it("ensureLabel swallows 422 only", async () => {
    route({ "POST /labels": fail(422) });
    await expect(client().ensureLabel("n", "c", "d")).resolves.toBeUndefined();
    route({ "POST /labels": fail(500) });
    await expect(client().ensureLabel("n", "c", "d")).rejects.toMatchObject({ status: 500 });
  });

  it("listFiles keeps blobs", async () => {
    route({
      "GET /git/trees/main?recursive=1": {
        tree: [{ path: "a", type: "blob" }, { path: "d", type: "tree" }],
      },
    });
    expect(await client().listFiles("main")).toEqual(["a"]);
  });

  describe("readFile / commitFile", () => {
    it("decodes content, and returns null on 404", async () => {
      route({
        "GET /contents/a/b.txt?ref=main": { content: Buffer.from("hi").toString("base64") },
        "GET /contents/empty?ref=main": {},
      });
      const c = client();
      expect(await c.readFile("a/b.txt", "main")).toBe("hi");
      expect(await c.readFile("empty", "main")).toBe("");
      expect(await c.readFile("gone", "main")).toBeNull();
    });

    it("rethrows other readFile failures", async () => {
      route({ "GET /contents/a?ref=main": fail(500) });
      await expect(client().readFile("a", "main")).rejects.toMatchObject({ status: 500 });
    });

    it("commitFile sends the existing sha when the file exists", async () => {
      const calls = route({ "GET /contents/a?ref=b": { sha: "old" }, "PUT /contents/a": {} });
      await client().commitFile("b", "a", "hi", "msg");
      expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
        message: "msg",
        content: Buffer.from("hi").toString("base64"),
        branch: "b",
        sha: "old",
      });
    });

    it("commitFile creates a new file without a sha", async () => {
      const calls = route({ "PUT /contents/a": {} });
      await client().commitFile("b", "a", "hi", "msg");
      expect(JSON.parse(String(calls[1]!.init.body))).not.toHaveProperty("sha");
    });

    it("commitFile rethrows a non-404 lookup failure", async () => {
      route({ "GET /contents/a?ref=b": fail(500) });
      await expect(client().commitFile("b", "a", "x", "m")).rejects.toMatchObject({ status: 500 });
    });
  });

  describe("pull request lookups", () => {
    it("findPullRequest returns the first open pull or null", async () => {
      route({
        "GET /pulls?state=open&head=acme%3Afeat": [RAW_PULL],
        "GET /pulls?state=open&head=acme%3Anone": [],
      });
      const c = client();
      expect((await c.findPullRequest("feat"))?.number).toBe(7);
      expect(await c.findPullRequest("none")).toBeNull();
    });

    it("closeSupersededPulls comments on and closes stale pulls only", async () => {
      const other = { ...RAW_PULL, number: 8, head: { sha: "x", ref: "formic/old" } };
      const keep = { ...RAW_PULL, number: 9, head: { sha: "y", ref: "formic/new" } };
      const unrelated = { ...RAW_PULL, number: 10, head: { sha: "z", ref: "other" } };
      const calls = route({
        "GET /pulls?state=open&per_page=100": [other, keep, unrelated],
        "POST /issues/8/comments": {},
        "PATCH /pulls/8": {},
      });
      expect(await client().closeSupersededPulls("formic/", "formic/new", "why")).toEqual([8]);
      expect(calls.map((c) => c.init.method)).toEqual(["GET", "POST", "PATCH"]);
    });
  });

  describe("workflow runs", () => {
    const RUNS = {
      workflow_runs: [
        { id: 1, display_title: "a", status: "completed", conclusion: "success", html_url: "https://x/actions/runs/1" },
        { id: 2, display_title: "b", status: "queued", conclusion: null, html_url: "https://x/actions/runs/2" },
      ],
    };
    const RUNS_KEY = "GET /actions/workflows/ci.yml/runs?event=workflow_dispatch&per_page=50";

    it("dispatches a workflow", async () => {
      const calls = route({ "POST /actions/workflows/ci.yml/dispatches": {} });
      await client().dispatchWorkflow("ci.yml", "main", { a: "1" });
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ref: "main", inputs: { a: "1" } });
    });

    it("findRun matches by title", async () => {
      route({ [RUNS_KEY]: RUNS });
      const c = client();
      expect(await c.findRun("ci.yml", "b")).toEqual({ status: "queued", conclusion: null, url: "https://x/actions/runs/2" });
      expect(await c.findRun("ci.yml", "zzz")).toBeNull();
    });

    it("branchRuns defaults the name, attempt and start", async () => {
      route({
        "GET /actions/runs?branch=feat&exclude_pull_requests=true&per_page=50": {
          workflow_runs: [
            { name: null, head_sha: "s", status: "completed", conclusion: "failure", created_at: "c", updated_at: "u", html_url: "h" },
          ],
        },
      });
      expect(await client().branchRuns("feat")).toEqual([
        { name: "workflow", sha: "s", status: "completed", conclusion: "failure", attempt: 1, startedAt: "c", updatedAt: "u", url: "h" },
      ]);
    });

    it("cancels a run", async () => {
      const calls = route({ "POST /actions/runs/3/cancel": {} });
      await client().cancelRun(3);
      expect(calls[0]!.init.body).toBeUndefined();
    });
  });

  describe("runLog", () => {
    it("is null for a url without a run id", async () => {
      const calls = route({});
      expect(await client().runLog("https://x/nothing")).toBeNull();
      expect(calls).toHaveLength(0);
    });

    it("is null when there are no jobs", async () => {
      route({ "GET /actions/runs/4/jobs?filter=latest": { jobs: [] } });
      expect(await client().runLog("https://x/actions/runs/4")).toBeNull();
    });

    it("reads the failed job's log, falling back to null on a bad response", async () => {
      route({
        "GET /actions/runs/4/jobs?filter=latest": {
          jobs: [{ id: 1, conclusion: "success" }, { id: 2, conclusion: "failure" }],
        },
        "GET /actions/jobs/2/logs": () => new Response("log text"),
      });
      expect(await client().runLog("https://x/actions/runs/4")).toBe("log text");

      route({
        "GET /actions/runs/4/jobs?filter=latest": { jobs: [{ id: 1, conclusion: "success" }] },
        "GET /actions/jobs/1/logs": fail(500),
      });
      expect(await client().runLog("https://x/actions/runs/4")).toBeNull();
    });
  });

  it("compare collects files (renames included), messages and head sha", async () => {
    route({
      "GET /compare/main...feat": {
        files: [
          { filename: "b.ts", previous_filename: "a.ts", patch: "@@" },
          { filename: "c.ts" },
        ],
        commits: [{ sha: "1", commit: { message: "m1" } }, { sha: "2", commit: { message: "m2" } }],
      },
    });
    expect(await client().compare("main", "feat")).toEqual({
      files: ["b.ts", "a.ts", "c.ts"],
      messages: ["m1", "m2"],
      headSha: "2",
      patches: [{ path: "b.ts", patch: "@@" }],
    });
  });

  it("compare tolerates no files and no commits", async () => {
    route({ "GET /compare/main...feat": { commits: [] } });
    expect(await client().compare("main", "feat")).toEqual({ files: [], messages: [], headSha: "", patches: [] });
  });

  describe("security", () => {
    it("narrows each source and reports an unavailable one as such", async () => {
      route({
        "GET /dependabot/alerts?state=open&per_page=100": [
          {
            dependency: { package: { name: "p", ecosystem: "npm" }, manifest_path: "package.json" },
            security_advisory: { severity: "high", summary: "s" },
            security_vulnerability: { first_patched_version: null },
          },
        ],
        "GET /secret-scanning/alerts?state=open&per_page=100": [
          { secret_type: "tok", created_at: "t", secret: "SECRET" },
        ],
        "GET /code-scanning/alerts?state=open&per_page=100": fail(404),
        "GET /branches/main": { protected: true, protection: { required_status_checks: { contexts: ["ci"] } } },
        "GET ": { visibility: "private", security_and_analysis: { x: { status: "enabled" }, y: null } },
      });
      const facts = await client().security("main");
      expect(facts.dependabot).toEqual({
        ok: true,
        items: [{ package: "p", ecosystem: "npm", severity: "high", summary: "s", manifest: "package.json", fixedIn: null }],
      });
      expect(facts.secrets).toEqual({ ok: true, items: [{ type: "tok", createdAt: "t", pushProtectionBypassed: false }] });
      expect(JSON.stringify(facts)).not.toContain("SECRET");
      expect(facts.codeScanning).toMatchObject({ ok: false });
      expect((facts.codeScanning as { reason: string }).reason).toContain("404");
      expect(facts.protection).toEqual({ ok: true, protected: true, requiredChecks: ["ci"] });
      expect(facts.settings).toEqual({ ok: true, visibility: "private", features: { x: "enabled", y: "unknown" } });
    });

    it("reports an unreadable repository and branch", async () => {
      route({
        "GET /branches/main": fail(403),
        "GET ": fail(500),
      });
      const facts = await client().security("main");
      expect(facts.settings).toEqual({ ok: false, reason: "GitHub answered 500" });
      expect(facts.protection).toMatchObject({ ok: false });
    });
  });

  describe("snapshot", () => {
    it("fails with the status when the tarball is refused", async () => {
      route({ "GET /tarball/main": fail(404) });
      await expect(client().snapshot("main", () => true, 100)).rejects.toMatchObject({ status: 404 });
    });

    it("wraps a network failure in a VcsError", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("down");
      });
      await expect(client().snapshot("main", () => true, 100)).rejects.toThrow(/Could not reach GitHub: down/);
    });
  });

  describe("artifacts", () => {
    it("is null when no completed run has a matching artifact", async () => {
      route({
        "GET /actions/runs?branch=feat&exclude_pull_requests=true&per_page=50": {
          workflow_runs: [
            { name: "w", head_sha: "s", status: "queued", conclusion: null, created_at: "c", updated_at: "u", html_url: "https://x/actions/runs/1" },
            { name: "w", head_sha: "s", status: "completed", conclusion: "success", created_at: "c", updated_at: "u", html_url: "https://x/nothing" },
            { name: "w", head_sha: "s", status: "completed", conclusion: "success", created_at: "c", updated_at: "u", html_url: "https://x/actions/runs/2" },
          ],
        },
        "GET /actions/runs/2/artifacts?per_page=100": {
          artifacts: [
            { name: "old", expired: true, archive_download_url: "u", size_in_bytes: 1 },
            { name: "big", expired: false, archive_download_url: "u", size_in_bytes: 1000 },
          ],
        },
      });
      expect(await client().artifacts("feat", /./, () => true, 100)).toBeNull();
    });
  });
});
