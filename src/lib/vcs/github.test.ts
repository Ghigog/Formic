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
});
