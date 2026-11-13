import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabClient } from "./gitlab";
import { BranchMovedError, VcsError } from "./types";
import { runTitle } from "@/lib/runner/workflow";

/**
 * The GitLab client against a fake gitlab.com: each test says what GitLab
 * answers, and checks what the client asked for and how it read the answer.
 */

type Handler = (req: { method: string; path: string; body: unknown }) => Response | Promise<Response>;

const BASE = "https://gitlab.com/api/v4/projects/acme%2Ftools%2Fwidgets";
let routes: Array<{ method: string; pattern: RegExp; handle: Handler }>;
let calls: Array<{ method: string; path: string; body: unknown }>;

function on(method: string, pattern: RegExp, handle: Handler | unknown) {
  routes.push({
    method,
    pattern,
    handle: typeof handle === "function" ? (handle as Handler) : () => Response.json(handle),
  });
}

beforeEach(() => {
  routes = [];
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const full = String(url);
    const path = full.startsWith(BASE) ? full.slice(BASE.length) : full.replace("https://gitlab.com/api/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) return Response.json({ message: `no route for ${method} ${path}` }, { status: 404 });
    return route.handle({ method, path, body });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const client = () => new GitLabClient("acme/tools/widgets", "glo_token");
const mr = (over: Record<string, unknown> = {}) => ({
  iid: 4,
  web_url: "https://gitlab.com/acme/tools/widgets/-/merge_requests/4",
  state: "opened",
  title: "T-1: a change",
  sha: "head1",
  source_branch: "formic/t-1",
  target_branch: "main",
  has_conflicts: false,
  detailed_merge_status: "mergeable",
  ...over,
});

describe("files and branches", () => {
  it("reads a file's text, and null where it is not", async () => {
    on("GET", /^\/repository\/files\/README\.md\/raw/, () => new Response("hello"));
    expect(await client().readFile("README.md", "main")).toBe("hello");
    expect(await client().readFile("missing.md", "main")).toBeNull();
    expect(calls[0]!.path).toBe("/repository/files/README.md/raw?ref=main");
  });

  it("creates a file that is not there and updates one that is", async () => {
    on("GET", /^\/repository\/files\/new\.txt\/raw/, () => Response.json({}, { status: 404 }));
    on("GET", /^\/repository\/files\/old\.txt\/raw/, () => new Response("before"));
    on("POST", /^\/repository\/commits$/, { id: "c1" });

    await client().commitFile("main", "new.txt", "a", "add");
    await client().commitFile("main", "old.txt", "b", "change");

    const commits = calls.filter((c) => c.method === "POST").map((c) => c.body as { actions: Array<{ action: string }> });
    expect(commits.map((c) => c.actions[0]!.action)).toEqual(["create", "update"]);
  });

  it("moves a branch only forward, by making it again at the new commit", async () => {
    on("GET", /^\/repository\/branches\/formic%2Ft-1$/, { commit: { id: "old" } });
    on("GET", /^\/repository\/merge_base/, { id: "old" });
    on("DELETE", /^\/repository\/branches\/formic%2Ft-1$/, () => new Response(null, { status: 204 }));
    on("POST", /^\/repository\/branches\?branch=formic%2Ft-1&ref=new$/, { name: "formic/t-1" });

    await client().moveBranch("formic/t-1", "new");

    expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
      "GET /repository/branches/formic%2Ft-1",
      "GET /repository/merge_base",
      "DELETE /repository/branches/formic%2Ft-1",
      "POST /repository/branches",
    ]);
  });

  it("refuses to move a branch anywhere but forward, and deletes nothing", async () => {
    on("GET", /^\/repository\/branches\/formic%2Ft-1$/, { commit: { id: "old" } });
    on("GET", /^\/repository\/merge_base/, { id: "elsewhere" });

    const err = await client().moveBranch("formic/t-1", "new").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchMovedError);
    expect(err).toMatchObject({ branch: "formic/t-1", head: "old" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("cherry-picks a commit onto a branch that moved, or reports the conflict", async () => {
    on("POST", /^\/repository\/commits\/agent1\/cherry_pick\?branch=formic%2Ft-1$/, { id: "picked" });
    expect(await client().mergeOntoBranch("formic/t-1", "agent1")).toEqual({ ok: true, sha: "picked" });

    on("POST", /cherry_pick\?branch=other$/, () => Response.json({ message: "Sorry, we cannot cherry-pick: conflict" }, { status: 400 }));
    expect(await client().mergeOntoBranch("other", "agent1")).toMatchObject({ ok: false, conflict: true });
  });

  it("deletes only staging branches", async () => {
    await expect(client().deleteStagingBranch("main")).rejects.toBeInstanceOf(VcsError);
    expect(calls).toEqual([]);
  });
});

describe("merge requests", () => {
  it("reads a merge request as a pull request, with GitLab's merge status as mergeability", async () => {
    on("GET", /^\/merge_requests\/4$/, mr());
    on("GET", /^\/merge_requests\/5$/, mr({ iid: 5, detailed_merge_status: "checking" }));
    on("GET", /^\/merge_requests\/6$/, mr({ iid: 6, has_conflicts: true, detailed_merge_status: "conflict" }));
    on("GET", /^\/merge_requests\/7$/, mr({ iid: 7, state: "merged" }));

    expect(await client().pullRequest(4)).toMatchObject({ number: 4, headSha: "head1", headBranch: "formic/t-1", baseBranch: "main", state: "open", mergeable: true });
    expect((await client().pullRequest(5)).mergeable).toBeNull();
    expect((await client().pullRequest(6)).mergeable).toBe(false);
    expect(await client().pullRequest(7)).toMatchObject({ state: "closed", merged: true });
  });

  it("squash-merges at the reviewed head, and merges plainly where the project never squashes", async () => {
    let tries = 0;
    on("PUT", /^\/merge_requests\/4\/merge$/, ({ body }: { body: unknown }) => {
      tries++;
      if ((body as { squash: boolean }).squash) {
        return Response.json({ message: "Squashing not allowed: This project doesn't allow you to squash commits" }, { status: 405 });
      }
      return Response.json(mr({ state: "merged", merge_commit_sha: "m1" }));
    });

    expect(await client().merge(4, "head1")).toEqual({ ok: true, sha: "m1" });
    expect(tries).toBe(2);
    expect((calls.at(-1)!.body as { sha: string }).sha).toBe("head1");
  });

  it("calls a merge GitLab refuses with 406 a conflict", async () => {
    on("PUT", /^\/merge_requests\/4\/merge$/, () => Response.json({ message: "Branch cannot be merged" }, { status: 406 }));
    expect(await client().merge(4, "head1")).toMatchObject({ ok: false, conflict: true });
  });

  it("brings one branch into another through a merge request with a merge commit", async () => {
    on("GET", /^\/repository\/compare/, { commits: [{ id: "x" }] });
    on("POST", /^\/merge_requests$/, mr({ iid: 9, source_branch: "main", target_branch: "formic/t-1" }));
    on("GET", /^\/merge_requests\/9$/, mr({ iid: 9 }));
    on("PUT", /^\/merge_requests\/9\/merge$/, mr({ iid: 9, state: "merged" }));

    expect(await client().mergeBranch("formic/t-1", "main")).toEqual({ ok: true, updated: true });
    const opened = calls.find((c) => c.method === "POST")!.body as Record<string, string>;
    expect(opened).toMatchObject({ source_branch: "main", target_branch: "formic/t-1" });
    expect((calls.at(-1)!.body as { squash: boolean }).squash).toBe(false);
  });

  it("has nothing to merge when the base already holds everything, and opens no merge request", async () => {
    on("GET", /^\/repository\/compare/, { commits: [] });
    expect(await client().mergeBranch("formic/t-1", "main")).toEqual({ ok: true, updated: false });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("closes the merge request it opened when the branches conflict", async () => {
    on("GET", /^\/repository\/compare/, { commits: [{ id: "x" }] });
    on("POST", /^\/merge_requests$/, mr({ iid: 9 }));
    on("GET", /^\/merge_requests\/9$/, mr({ iid: 9, has_conflicts: true, detailed_merge_status: "conflict" }));
    on("PUT", /^\/merge_requests\/9$/, mr({ iid: 9, state: "closed" }));

    expect(await client().mergeBranch("formic/t-1", "main")).toMatchObject({ ok: false, conflict: true });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/merge_requests/9", body: { state_event: "close" } });
  });

  it("comments on a merge request, or on an issue when asked to", async () => {
    on("POST", /\/notes$/, { id: 1 });
    await client().comment(4, "on the change");
    await client().comment(12, "on the issue", "issue");
    expect(calls.map((c) => c.path)).toEqual(["/merge_requests/4/notes", "/issues/12/notes"]);
  });

  it("confirms a merge the job already pushed, and refuses to invent one", async () => {
    on("GET", /^\/repository\/commits\/merged$/, { parent_ids: ["start", "base"] });
    on("GET", /^\/repository\/commits\/plain$/, { parent_ids: ["start"] });
    expect(await client().recordMerge("merged", "base")).toBe("merged");
    await expect(client().recordMerge("plain", "base")).rejects.toThrow(/push the merge itself/);
  });
});

describe("checks", () => {
  it("lists each job's latest run on a commit, leaving out Formic's own job", async () => {
    on("GET", /^\/pipelines\?sha=abc/, [{ id: 2 }, { id: 1 }]);
    on("GET", /^\/pipelines\/2\/jobs/, [
      { id: 21, name: "test", status: "failed", allow_failure: false, web_url: "u21" },
      { id: 22, name: "lint", status: "failed", allow_failure: true, web_url: "u22" },
      { id: 23, name: "formic-agent", status: "success", web_url: "u23" },
    ]);
    on("GET", /^\/pipelines\/1\/jobs/, [{ id: 11, name: "test", status: "success", web_url: "u11" }]);

    const checks = await client().checksFor("abc");

    expect(checks).toEqual([
      { id: 21, name: "test", status: "completed", conclusion: "failure", detailsUrl: "u21" },
      { id: 22, name: "lint", status: "completed", conclusion: "neutral", detailsUrl: "u22" },
    ]);
  });

  it.each([
    ["no CI file", null, false],
    ["only Formic's include", "include:\n  - local: .gitlab/formic-agent.yml\n", false],
    ["a job of its own", "include:\n  - local: .gitlab/formic-agent.yml\ntest:\n  script: npm test\n", true],
    ["another include", "include:\n  - project: acme/ci\n    file: node.yml\n", true],
  ])("says whether there is CI to wait for: %s", async (_name, source, expected) => {
    on("GET", /^\/repository\/files\/\.gitlab-ci\.yml\/raw/, () =>
      source === null ? Response.json({}, { status: 404 }) : new Response(source),
    );
    expect(await client().hasCi("main")).toBe(expected);
  });
});

describe("Formic's runs", () => {
  it("starts a pipeline whose variables carry the run's inputs", async () => {
    on("POST", /^\/pipeline\?ref=main$/, { id: 30 });
    await client().dispatchWorkflow("formic-agent.yml", "main", { job: "t1--n", mode: "implement", prompt: "do it" });
    expect(calls[0]!.body).toEqual({
      variables: [
        { key: "FORMIC_RUN", value: "1", variable_type: "env_var" },
        { key: "FORMIC_JOB", value: "t1--n", variable_type: "env_var" },
        { key: "FORMIC_MODE", value: "implement", variable_type: "env_var" },
        { key: "FORMIC_PROMPT", value: "do it", variable_type: "env_var" },
      ],
    });
  });

  it("finds its runs by title, judged by its own job and not the project's", async () => {
    on("GET", /^\/pipelines\?source=api/, [{ id: 31 }, { id: 30 }]);
    on("GET", /^\/pipelines\/31\/variables$/, [{ key: "SOMETHING", value: "else" }]);
    on("GET", /^\/pipelines\/30\/variables$/, [
      { key: "FORMIC_RUN", value: "1" },
      { key: "FORMIC_MODE", value: "implement" },
      { key: "FORMIC_TICKET", value: "T-1" },
      { key: "FORMIC_JOB", value: "t1--n" },
    ]);
    on("GET", /^\/pipelines\/30\/jobs/, [
      { id: 301, name: "test", status: "failed", web_url: "u301" },
      { id: 302, name: "formic-agent", status: "failed", failure_reason: "job_execution_timeout", web_url: "https://gitlab.com/acme/tools/widgets/-/jobs/302" },
    ]);

    const runs = await client().recentRuns("formic-agent.yml");

    expect(runs).toEqual([
      {
        id: 302,
        title: runTitle("implement", "T-1", "t1--n"),
        status: "completed",
        conclusion: "timed_out",
        url: "https://gitlab.com/acme/tools/widgets/-/jobs/302",
      },
    ]);
  });
});

describe("checkpoints", () => {
  it("saves a card's work on its own branch from the work's base, with no pipeline, and reads it back clean", async () => {
    on("GET", /^\/repository\/tree/, [{ path: "a.ts", type: "blob" }, { path: "gone.ts", type: "blob" }]);
    on("POST", /^\/repository\/commits$/, { id: "cp1" });
    on("GET", /^\/repository\/branches\/formic-checkpoints%2Fticket_1$/, { commit: { id: "cp1" } });
    on("GET", /^\/repository\/commits\/cp1$/, { parent_ids: ["base1"], message: "T-1: checkpoint\n\nnotes\n\n[skip ci]\n" });

    const sha = await client().saveCheckpoint("ticket_1", {
      base: "base1",
      files: [
        { path: "a.ts", mode: "100644", content: Buffer.from("x").toString("base64") },
        { path: "run.sh", mode: "100755", content: Buffer.from("y").toString("base64") },
      ],
      deleted: ["gone.ts"],
      message: "T-1: checkpoint\n\nnotes",
    });

    expect(sha).toBe("cp1");
    const saved = calls.find((c) => c.method === "POST")!.body as {
      branch: string;
      start_sha: string;
      force: boolean;
      commit_message: string;
      actions: Array<{ action: string; file_path: string; execute_filemode?: boolean }>;
    };
    expect(saved).toMatchObject({ branch: "formic-checkpoints/ticket_1", start_sha: "base1", force: true });
    expect(saved.commit_message).toContain("[skip ci]");
    expect(saved.actions.map((a) => `${a.action} ${a.file_path}`)).toEqual(["update a.ts", "create run.sh", "delete gone.ts"]);
    expect(saved.actions[1]!.execute_filemode).toBe(true);

    expect(await client().checkpoint("ticket_1")).toEqual({ sha: "cp1", parent: "base1", message: "T-1: checkpoint\n\nnotes" });
  });
});

describe("preparing a project for Formic's job", () => {
  it("switches on job-token pushes and pipeline variables", async () => {
    on("PUT", /^$/, { id: 1 });
    await client().prepareRunner();
    expect(calls[0]!.body).toEqual({
      ci_push_repository_for_job_token_allowed: true,
      ci_pipeline_variables_minimum_override_role: "developer",
    });
  });

  it("says what to ask a Maintainer for when GitLab refuses", async () => {
    on("PUT", /^$/, () => Response.json({ message: "403 Forbidden" }, { status: 403 }));
    await expect(client().prepareRunner()).rejects.toThrow(/takes a Maintainer/);
  });

  it("makes Formic's webhook once, and brings an existing one up to date", async () => {
    on("GET", /^\/hooks/, [{ id: 7, url: "https://formic.example/api/webhooks/gitlab" }]);
    on("PUT", /^\/hooks\/7$/, { id: 7 });
    on("POST", /^\/hooks$/, { id: 8 });

    await client().ensureWebhook("https://formic.example/api/webhooks/gitlab", "tok");
    await client().ensureWebhook("https://elsewhere.example/api/webhooks/gitlab", "tok");

    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["PUT /hooks/7", "POST /hooks"]);
    expect(calls.at(-1)!.body).toMatchObject({ token: "tok", job_events: true, push_events: false });
  });
});
