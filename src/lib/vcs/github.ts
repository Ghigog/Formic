import "server-only";

import {
  type CheckLog,
  type CheckSummary,
  type MergeOutcome,
  type OpenPullRequestInput,
  type PullRequestDetail,
  type PullRequestRef,
  type UpdateOutcome,
  type VcsClient,
  type Comparison,
  type Checkpoint,
  type CheckpointInput,
  CHECKPOINT_REF_PREFIX,
  STAGING_PREFIX,
  VcsError,
  type IssuePatch,
  type IssueRef,
  type IssueFilter,
  type IssueState,
  type IssueSummary,
  type WorkflowRunRef,
  type BranchRun,
  type Snapshot,
  type ArtifactFiles,
  type SecurityFacts,
  type SecurityList,
} from "./types";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { untar, unzip, type Keep } from "./archive";
import { CARRY_DELETED, CARRY_DIR } from "@/lib/runner/workflow";

/**
 * GitHub REST over fetch.
 *
 * No SDK: the surface used here is six endpoints, and a dependency that can
 * reach the whole API is a larger blast radius than a file that can reach six
 * routes. Every response shape is narrowed at the boundary rather than typed
 * from a generated schema, so a field GitHub adds cannot change behaviour.
 */

const API = "https://api.github.com";

interface RawPull {
  number: number;
  html_url: string;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  title: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}

/** An issue as GitHub serves it, from either issues endpoint. */
interface RawIssue {
  number: number;
  id: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<string | { name?: string }>;
  /** Present only on a pull request, which the issues endpoints also return. */
  pull_request?: unknown;
  /** Set only on a sub-issue: a URL to the issue that parents it. */
  parent_issue_url?: string | null;
}

function toIssueSummary(raw: RawIssue): IssueSummary {
  return {
    number: raw.number,
    id: raw.id,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    labels: raw.labels
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter(Boolean),
    subIssue: Boolean(raw.parent_issue_url),
  };
}

function toDetail(raw: RawPull): PullRequestDetail {
  return {
    number: raw.number,
    url: raw.html_url,
    headSha: raw.head.sha,
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
    state: raw.state === "closed" ? "closed" : "open",
    merged: Boolean(raw.merged),
    mergeable: raw.mergeable ?? null,
    title: raw.title,
  };
}

/** Why GitHub would not answer, in words a report can carry. */
function unavailable(e: unknown): string {
  if (e instanceof VcsError && (e.status === 403 || e.status === 404)) {
    return `not available to this token, or not turned on for the repository (${e.status})`;
  }
  return e instanceof Error ? e.message : String(e);
}

export class GitHubClient implements VcsClient {
  readonly name = "github";

  constructor(
    private readonly repoFullName: string,
    /** The project owner's token: their access, their name on the commits. */
    private readonly token: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const token = this.token;

    let response: Response;
    try {
      response = await fetch(`${API}/repos/${this.repoFullName}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new VcsError(
        `Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const text = await response.text();
    const data = text ? (JSON.parse(text) as T) : ({} as T);

    if (!response.ok) {
      const message =
        (data as { message?: string }).message ?? response.statusText;
      throw new VcsError(
        `GitHub ${method} ${path} failed (${response.status}): ${message}`,
        response.status,
      );
    }

    return { status: response.status, data };
  }

  async ensureBranch(branch: string, fromRef: string): Promise<void> {
    try {
      await this.request("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
      return;
    } catch (e) {
      if (!(e instanceof VcsError) || e.status !== 404) throw e;
    }

    const { data } = await this.request<{ object: { sha: string } }>(
      "GET",
      `/git/ref/heads/${encodeURIComponent(fromRef)}`,
    );
    await this.request("POST", "/git/refs", {
      ref: `refs/heads/${branch}`,
      sha: data.object.sha,
    });
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
    const { data } = await this.request<RawPull>("POST", "/pulls", {
      title: input.title,
      body: input.body,
      head: input.headBranch,
      base: input.baseBranch,
      maintainer_can_modify: true,
    });
    return toDetail(data);
  }

  async pullRequest(number: number): Promise<PullRequestDetail> {
    const { data } = await this.request<RawPull>("GET", `/pulls/${number}`);
    return toDetail(data);
  }

  async checksFor(sha: string): Promise<CheckSummary[]> {
    const { data } = await this.request<{
      check_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        details_url: string | null;
      }>;
    }>("GET", `/commits/${sha}/check-runs?per_page=100`);

    return data.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status as CheckSummary["status"],
      conclusion: run.conclusion as CheckSummary["conclusion"],
      detailsUrl: run.details_url,
    }));
  }

  async checkLog(checkRunId: number): Promise<CheckLog> {
    const { data } = await this.request<{
      name: string;
      output: { title: string | null; summary: string | null; text: string | null };
    }>("GET", `/check-runs/${checkRunId}`);

    // Annotations are the only structured failure detail the API exposes
    // without downloading and unzipping a job log archive. They carry the
    // file, the line and the assertion, which is most of what a fix needs.
    let annotations: CheckLog["annotations"] = [];
    try {
      const listed = await this.request<
        Array<{ path: string; start_line: number | null; message: string }>
      >("GET", `/check-runs/${checkRunId}/annotations?per_page=50`);
      annotations = listed.data.map((a) => ({
        path: a.path,
        line: a.start_line,
        message: a.message,
      }));
    } catch {
      // A check run without annotations is normal, not a failure.
    }

    return {
      name: data.name,
      summary: [data.output?.title, data.output?.summary, data.output?.text]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 20_000),
      annotations,
    };
  }

  async updateBranch(number: number): Promise<UpdateOutcome> {
    try {
      await this.request("PUT", `/pulls/${number}/update-branch`, {});
      return { ok: true, updated: true };
    } catch (e) {
      if (!(e instanceof VcsError)) throw e;
      // 422 here means the merge would conflict, or the branch is already
      // current. Neither is an error worth failing a run over; the caller
      // re-reads mergeability and decides.
      if (e.status === 422) {
        return {
          ok: false,
          reason: e.message,
          conflict: /conflict|merge/i.test(e.message),
        };
      }
      throw e;
    }
  }

  async bringsInBase(from: string, to: string, base: string): Promise<boolean> {
    try {
      const { data: commit } = await this.request<{ parents: Array<{ sha: string }> }>(
        "GET",
        `/commits/${to}`,
      );
      const [first, second] = commit.parents.map((p) => p.sha);
      if (commit.parents.length !== 2 || first !== from) return false;
      // "behind" or "identical": the other parent is already on base.
      const { data } = await this.request<{ status: string }>(
        "GET",
        `/compare/${encodeURIComponent(base)}...${second}`,
      );
      return data.status === "behind" || data.status === "identical";
    } catch (e) {
      if (e instanceof VcsError) return false;
      throw e;
    }
  }

  async mergeBranch(base: string, head: string): Promise<UpdateOutcome> {
    try {
      const { status } = await this.request("POST", "/merges", {
        base,
        head,
        commit_message: `Bring ${head} into ${base}`,
      });
      // 201 made a merge commit; 204 means base already had everything.
      return { ok: true, updated: status === 201 };
    } catch (e) {
      if (!(e instanceof VcsError)) throw e;
      if (e.status === 409) return { ok: false, reason: e.message, conflict: true };
      throw e;
    }
  }

  async merge(number: number, expectedHeadSha: string): Promise<MergeOutcome> {
    try {
      const { data } = await this.request<{ sha: string; merged: boolean }>(
        "PUT",
        `/pulls/${number}/merge`,
        {
          sha: expectedHeadSha,
          merge_method: "squash",
        },
      );
      return data.merged
        ? { ok: true, sha: data.sha }
        : { ok: false, reason: "GitHub declined the merge.", conflict: false };
    } catch (e) {
      if (!(e instanceof VcsError)) throw e;
      return {
        ok: false,
        reason: e.message,
        // 409 is "head moved or the branch cannot be merged"; 405 is "not
        // mergeable", which on a PR that was green means a conflict.
        conflict: e.status === 409 || e.status === 405,
      };
    }
  }

  async comment(number: number, body: string): Promise<void> {
    await this.request("POST", `/issues/${number}/comments`, { body });
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueRef> {
    const { data } = await this.request<{ number: number; id: number; html_url: string }>(
      "POST",
      "/issues",
      input,
    );
    return { number: data.number, id: data.id, url: data.html_url };
  }

  async updateIssue(number: number, patch: IssuePatch): Promise<void> {
    await this.request("PATCH", `/issues/${number}`, patch);
  }

  async issues(state: IssueState, filter: IssueFilter = {}): Promise<IssueSummary[]> {
    const query = new URLSearchParams({ state, per_page: "100" });
    if (filter.labels?.length) query.set("labels", filter.labels.join(","));
    if (filter.since) query.set("since", filter.since);
    const { data } = await this.request<RawIssue[]>("GET", `/issues?${query.toString()}`);
    // The issues endpoints serve pull requests too, and their numbers collide
    // with real issues. A pull request is never something to import.
    return data.filter((issue) => !issue.pull_request).map(toIssueSummary);
  }

  async issue(number: number): Promise<IssueSummary | null> {
    try {
      const { data } = await this.request<RawIssue>("GET", `/issues/${number}`);
      return data.pull_request ? null : toIssueSummary(data);
    } catch (e) {
      if (e instanceof VcsError && e.status === 404) return null;
      throw e;
    }
  }

  async addSubIssue(parentNumber: number, childId: number): Promise<void> {
    await this.request("POST", `/issues/${parentNumber}/sub_issues`, { sub_issue_id: childId });
  }

  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    try {
      await this.request("POST", "/labels", { name, color, description });
    } catch (e) {
      // 422: it already exists, which is all this asks for.
      if (!(e instanceof VcsError) || e.status !== 422) throw e;
    }
  }

  async listFiles(ref: string): Promise<string[]> {
    const { data } = await this.request<{ tree: Array<{ path: string; type: string }> }>(
      "GET",
      `/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    return data.tree.filter((t) => t.type === "blob").map((t) => t.path);
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.request<{ content?: string; encoding?: string }>(
        "GET",
        `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      );
      return data.content ? Buffer.from(data.content, "base64").toString("utf8") : "";
    } catch (e) {
      if (e instanceof VcsError && e.status === 404) return null;
      throw e;
    }
  }

  async commitFile(branch: string, path: string, content: string, message: string): Promise<void> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    let sha: string | undefined;
    try {
      const { data } = await this.request<{ sha: string }>(
        "GET",
        `/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
      );
      sha = data.sha;
    } catch (e) {
      if (!(e instanceof VcsError) || e.status !== 404) throw e;
    }
    await this.request("PUT", `/contents/${encoded}`, {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    });
  }

  async findPullRequest(headBranch: string): Promise<PullRequestRef | null> {
    const owner = this.repoFullName.split("/")[0];
    const { data } = await this.request<RawPull[]>(
      "GET",
      `/pulls?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}`,
    );
    return data[0] ? toDetail(data[0]) : null;
  }

  async closeSupersededPulls(prefix: string, keepBranch: string, reason: string): Promise<number[]> {
    const { data } = await this.request<RawPull[]>("GET", "/pulls?state=open&per_page=100");
    const stale = data.filter((p) => p.head.ref.startsWith(prefix) && p.head.ref !== keepBranch);
    for (const pull of stale) {
      await this.comment(pull.number, reason);
      await this.request("PATCH", `/pulls/${pull.number}`, { state: "closed" });
    }
    return stale.map((p) => p.number);
  }

  async setSecret(name: string, value: string): Promise<void> {
    const { data: key } = await this.request<{ key_id: string; key: string }>(
      "GET",
      "/actions/secrets/public-key",
    );
    // GitHub requires a libsodium sealed box to the repository's public key:
    // only Actions can open it, and nothing reading the API can.
    const sodium = (await import("libsodium-wrappers")).default;
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(
      sodium.from_string(value),
      sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
    );
    await this.request("PUT", `/actions/secrets/${encodeURIComponent(name)}`, {
      encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
      key_id: key.key_id,
    });
  }

  async dispatchWorkflow(file: string, ref: string, inputs: Record<string, string>): Promise<void> {
    await this.request("POST", `/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
      ref,
      inputs,
    });
  }

  async findRun(file: string, title: string): Promise<WorkflowRunRef | null> {
    const run = (await this.recentRuns(file)).find((r) => r.title === title);
    return run ? { status: run.status, conclusion: run.conclusion, url: run.url } : null;
  }

  async recentRuns(file: string): Promise<Array<WorkflowRunRef & { id: number; title: string }>> {
    const { data } = await this.request<{
      workflow_runs: Array<{
        id: number;
        display_title: string;
        status: string;
        conclusion: string | null;
        html_url: string;
      }>;
    }>("GET", `/actions/workflows/${encodeURIComponent(file)}/runs?event=workflow_dispatch&per_page=50`);
    return data.workflow_runs.map((r) => ({
      id: r.id,
      title: r.display_title,
      status: r.status,
      conclusion: r.conclusion,
      url: r.html_url,
    }));
  }

  async branchRuns(branch: string): Promise<BranchRun[]> {
    const { data } = await this.request<{
      workflow_runs: Array<{
        name: string | null;
        head_sha: string;
        status: string;
        conclusion: string | null;
        run_attempt?: number;
        run_started_at?: string;
        created_at: string;
        updated_at: string;
        html_url: string;
      }>;
    }>("GET", `/actions/runs?branch=${encodeURIComponent(branch)}&exclude_pull_requests=true&per_page=50`);
    return data.workflow_runs.map((r) => ({
      name: r.name ?? "workflow",
      sha: r.head_sha,
      status: r.status,
      conclusion: r.conclusion,
      attempt: r.run_attempt ?? 1,
      startedAt: r.run_started_at ?? r.created_at,
      updatedAt: r.updated_at,
      url: r.html_url,
    }));
  }

  async snapshot(ref: string, keep: Keep, budget: number): Promise<Snapshot> {
    // Through a redirect to codeload, which carries its own short-lived
    // token, so not through request(): fetch drops our header on the hop.
    const response = await fetch(`${API}/repos/${this.repoFullName}/tarball/${encodeURIComponent(ref)}`, {
      headers: this.headers(),
    }).catch((e: unknown) => {
      throw new VcsError(`Could not reach GitHub: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!response.ok || !response.body) {
      throw new VcsError(`GitHub GET /tarball/${ref} failed (${response.status})`, response.status);
    }
    const gunzip = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(createGunzip());
    return untar(gunzip, keep, budget);
  }

  async artifacts(branch: string, name: RegExp, keep: Keep, budget: number): Promise<ArtifactFiles | null> {
    const runs = (await this.branchRuns(branch)).filter((r) => r.status === "completed").slice(0, 10);
    for (const run of runs) {
      const runId = /\/actions\/runs\/(\d+)/.exec(run.url)?.[1];
      if (!runId) continue;
      const { data } = await this.request<{
        artifacts: Array<{ name: string; expired: boolean; archive_download_url: string; size_in_bytes: number }>;
      }>("GET", `/actions/runs/${runId}/artifacts?per_page=100`);
      const wanted = data.artifacts.filter((a) => !a.expired && name.test(a.name) && a.size_in_bytes <= budget);
      if (wanted.length === 0) continue;

      const files = new Map<string, Buffer>();
      let left = budget;
      for (const a of wanted) {
        const response = await fetch(a.archive_download_url, { headers: this.headers() }).catch(() => null);
        if (!response?.ok) continue;
        const zip = Buffer.from(await response.arrayBuffer());
        const { files: inner } = unzip(zip, keep, left);
        for (const [path, bytes] of inner) {
          files.set(`${a.name}/${path}`, bytes);
          left -= bytes.length;
        }
      }
      return { runUrl: run.url, files };
    }
    return null;
  }

  async security(branch: string): Promise<SecurityFacts> {
    const list = async <R, T>(path: string, map: (r: R) => T): Promise<SecurityList<T>> => {
      try {
        const { data } = await this.request<R[]>("GET", path);
        return { ok: true, items: data.map(map) };
      } catch (e) {
        return { ok: false, reason: unavailable(e) };
      }
    };

    const [dependabot, secrets, codeScanning, protection, settings] = await Promise.all([
      list<
        {
          dependency: { package: { name: string; ecosystem: string }; manifest_path: string };
          security_advisory: { severity: string; summary: string };
          security_vulnerability: { first_patched_version: { identifier: string } | null };
        },
        { package: string; ecosystem: string; severity: string; summary: string; manifest: string; fixedIn: string | null }
      >("/dependabot/alerts?state=open&per_page=100", (a) => ({
        package: a.dependency.package.name,
        ecosystem: a.dependency.package.ecosystem,
        severity: a.security_advisory.severity,
        summary: a.security_advisory.summary,
        manifest: a.dependency.manifest_path,
        fixedIn: a.security_vulnerability.first_patched_version?.identifier ?? null,
      })),
      // The alert carries the secret itself. Only its kind leaves here.
      list<
        { secret_type_display_name?: string; secret_type: string; created_at: string; push_protection_bypassed?: boolean },
        { type: string; createdAt: string; pushProtectionBypassed: boolean }
      >("/secret-scanning/alerts?state=open&per_page=100", (a) => ({
        type: a.secret_type_display_name ?? a.secret_type,
        createdAt: a.created_at,
        pushProtectionBypassed: Boolean(a.push_protection_bypassed),
      })),
      list<
        {
          rule: { id: string; security_severity_level?: string | null; severity?: string | null };
          tool: { name: string };
          most_recent_instance: { location: { path: string; start_line?: number } };
        },
        { rule: string; severity: string; tool: string; path: string; line: number | null }
      >("/code-scanning/alerts?state=open&per_page=100", (a) => ({
        rule: a.rule.id,
        severity: a.rule.security_severity_level ?? a.rule.severity ?? "unknown",
        tool: a.tool.name,
        path: a.most_recent_instance.location.path,
        line: a.most_recent_instance.location.start_line ?? null,
      })),
      this.request<{ protected: boolean; protection?: { required_status_checks?: { contexts?: string[] } } }>(
        "GET",
        `/branches/${encodeURIComponent(branch)}`,
      ).then(
        ({ data }) => ({
          ok: true as const,
          protected: data.protected,
          requiredChecks: data.protection?.required_status_checks?.contexts ?? [],
        }),
        (e: unknown) => ({ ok: false as const, reason: unavailable(e) }),
      ),
      fetch(`${API}/repos/${this.repoFullName}`, { headers: this.headers() })
        .then(async (r) => {
          if (!r.ok) return { ok: false as const, reason: `GitHub answered ${r.status}` };
          const data = (await r.json()) as { visibility?: string; security_and_analysis?: Record<string, { status?: string }> | null };
          const features = Object.fromEntries(
            Object.entries(data.security_and_analysis ?? {}).map(([k, v]) => [k, v?.status ?? "unknown"]),
          );
          return { ok: true as const, visibility: data.visibility ?? "unknown", features };
        })
        .catch((e: unknown) => ({ ok: false as const, reason: unavailable(e) })),
    ]);
    return { dependabot, secrets, codeScanning, protection, settings };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async cancelRun(runId: number): Promise<void> {
    await this.request("POST", `/actions/runs/${runId}/cancel`);
  }

  async runLog(runUrl: string): Promise<string | null> {
    const runId = /\/actions\/runs\/(\d+)/.exec(runUrl)?.[1];
    if (!runId) return null;
    const { data } = await this.request<{
      jobs: Array<{ id: number; conclusion: string | null }>;
    }>("GET", `/actions/runs/${runId}/jobs?filter=latest`);
    const job = data.jobs.find((j) => j.conclusion === "failure") ?? data.jobs[0];
    if (!job) return null;
    // The log is plain text behind a redirect, so not through request().
    const response = await fetch(`${API}/repos/${this.repoFullName}/actions/jobs/${job.id}/logs`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }).catch(() => null);
    if (!response?.ok) return null;
    return response.text();
  }

  async compare(base: string, head: string): Promise<Comparison> {
    const { data } = await this.request<{
      files?: Array<{ filename: string; previous_filename?: string }>;
      commits: Array<{ sha: string; commit: { message: string } }>;
    }>("GET", `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    const files = new Set<string>();
    for (const f of data.files ?? []) {
      files.add(f.filename);
      // A rename touches the path it left as well as the one it took.
      if (f.previous_filename) files.add(f.previous_filename);
    }
    return {
      files: [...files],
      messages: data.commits.map((c) => c.commit.message),
      headSha: data.commits.at(-1)?.sha ?? "",
    };
  }

  async landCarried(sha: string): Promise<{ sha: string; files: string[] }> {
    const { data: commit } = await this.request<{
      message: string;
      tree: { sha: string };
      parents: Array<{ sha: string }>;
      author: { name: string; email: string; date: string };
    }>("GET", `/git/commits/${sha}`);
    const { data: tree } = await this.request<{
      tree: Array<{ path: string; mode: string; type: string; sha: string }>;
    }>("GET", `/git/trees/${commit.tree.sha}?recursive=1`);

    type Entry = { path: string; mode: string; type: "blob"; sha: string | null };
    const entries: Entry[] = [];
    const files: string[] = [];
    for (const t of tree.tree) {
      if (t.type !== "blob") continue;
      if (t.path === CARRY_DELETED) {
        entries.push({ path: t.path, mode: t.mode, type: "blob", sha: null });
        const { data: blob } = await this.request<{ content: string }>("GET", `/git/blobs/${t.sha}`);
        for (const line of Buffer.from(blob.content, "base64").toString("utf8").split("\n")) {
          const path = line.trim();
          if (!path) continue;
          entries.push({ path, mode: "100644", type: "blob", sha: null });
          files.push(path);
        }
      } else if (t.path.startsWith(`${CARRY_DIR}/`)) {
        const path = t.path.slice(CARRY_DIR.length + 1);
        // The same blob, moved: nothing to upload again.
        entries.push({ path: t.path, mode: t.mode, type: "blob", sha: null });
        entries.push({ path, mode: t.mode, type: "blob", sha: t.sha });
        files.push(path);
      }
    }
    if (entries.length === 0) return { sha, files };

    const { data: landed } = await this.request<{ sha: string }>("POST", "/git/trees", {
      base_tree: commit.tree.sha,
      tree: entries,
    });
    const { data: rewritten } = await this.request<{ sha: string }>("POST", "/git/commits", {
      message: commit.message,
      tree: landed.sha,
      parents: commit.parents.map((p) => p.sha),
      author: commit.author,
    });
    return { sha: rewritten.sha, files };
  }

  async recordMerge(sha: string, merged: string): Promise<string> {
    const { data: commit } = await this.request<{
      message: string;
      tree: { sha: string };
      parents: Array<{ sha: string }>;
      author: { name: string; email: string; date: string };
    }>("GET", `/git/commits/${sha}`);
    const { data: merge } = await this.request<{ sha: string }>("POST", "/git/commits", {
      message: commit.message,
      tree: commit.tree.sha,
      parents: [...commit.parents.map((p) => p.sha), merged],
      author: commit.author,
    });
    return merge.sha;
  }

  async moveBranch(branch: string, sha: string): Promise<void> {
    try {
      await this.request("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha,
        force: false,
      });
    } catch (e) {
      if (!(e instanceof VcsError) || (e.status !== 404 && e.status !== 422)) throw e;
      // 422 on a branch that does not exist yet: create it instead. On one
      // that does exist it means "not a fast-forward", and creating fails too,
      // which is the refusal we want.
      await this.request("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
    }
  }

  async deleteStagingBranch(branch: string): Promise<void> {
    if (!branch.startsWith(STAGING_PREFIX)) {
      throw new VcsError(`Refusing to delete ${branch}: only ${STAGING_PREFIX} branches.`);
    }
    try {
      await this.request("DELETE", `/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
    } catch (e) {
      if (!(e instanceof VcsError) || e.status !== 422) throw e;
    }
  }

  async branchHead(branch: string): Promise<string | null> {
    try {
      const { data } = await this.request<{ object: { sha: string } }>(
        "GET",
        `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      );
      return data.object.sha;
    } catch (e) {
      if (e instanceof VcsError && e.status === 404) return null;
      throw e;
    }
  }

  async saveCheckpoint(card: string, input: CheckpointInput): Promise<string> {
    const { data: base } = await this.request<{ tree: { sha: string } }>("GET", `/git/commits/${input.base}`);
    type Entry = { path: string; mode: string; type: "blob"; sha?: string | null; content?: string };
    const entries: Entry[] = [];
    for (const f of input.files) {
      const bytes = Buffer.from(f.content, "base64");
      const text = bytes.toString("utf8");
      // Text goes inline with the tree; anything else needs a blob of its own.
      if (!bytes.includes(0) && Buffer.from(text, "utf8").equals(bytes)) {
        entries.push({ path: f.path, mode: f.mode, type: "blob", content: text });
      } else {
        const { data: blob } = await this.request<{ sha: string }>("POST", "/git/blobs", {
          content: f.content,
          encoding: "base64",
        });
        entries.push({ path: f.path, mode: f.mode, type: "blob", sha: blob.sha });
      }
    }
    for (const path of input.deleted) entries.push({ path, mode: "100644", type: "blob", sha: null });

    let tree = base.tree.sha;
    if (entries.length > 0) {
      const { data } = await this.request<{ sha: string }>("POST", "/git/trees", { base_tree: tree, tree: entries });
      tree = data.sha;
    }
    const { data: commit } = await this.request<{ sha: string }>("POST", "/git/commits", {
      message: input.message,
      tree,
      parents: [input.base],
    });

    const ref = `${CHECKPOINT_REF_PREFIX}${card}`;
    try {
      await this.request("PATCH", `/git/${checkpointPath(card)}`, { sha: commit.sha, force: true });
    } catch (e) {
      if (!(e instanceof VcsError) || (e.status !== 404 && e.status !== 422)) throw e;
      await this.request("POST", "/git/refs", { ref, sha: commit.sha });
    }
    return commit.sha;
  }

  async checkpoint(card: string): Promise<Checkpoint | null> {
    let sha: string;
    try {
      const { data } = await this.request<{ object: { sha: string } }>(
        "GET",
        `/git/${checkpointPath(card).replace(/^refs\//, "ref/")}`,
      );
      sha = data.object.sha;
    } catch (e) {
      if (e instanceof VcsError && e.status === 404) return null;
      throw e;
    }
    const { data: commit } = await this.request<{ message: string; parents: Array<{ sha: string }> }>(
      "GET",
      `/git/commits/${sha}`,
    );
    const parent = commit.parents[0]?.sha;
    return parent ? { sha, parent, message: commit.message } : null;
  }

  async deleteCheckpoint(card: string): Promise<void> {
    try {
      await this.request("DELETE", `/git/${checkpointPath(card)}`);
    } catch (e) {
      if (!(e instanceof VcsError) || (e.status !== 404 && e.status !== 422)) throw e;
    }
  }
}

/** A card's checkpoint ref as a REST path under /git/: `refs/formic/checkpoints/<card>`. */
function checkpointPath(card: string): string {
  return `${CHECKPOINT_REF_PREFIX}${encodeURIComponent(card)}`;
}
