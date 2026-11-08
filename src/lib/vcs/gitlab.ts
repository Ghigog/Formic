import "server-only";

import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { untar, unzip, type Keep } from "./archive";
import { gl, glBytes, glPages, GITLAB_API, glHeaders, projectId } from "./gitlab-api";
import {
  STAGING_PREFIX,
  VcsError,
  type ActionsMachines,
  type ArtifactFiles,
  type BranchRun,
  type CheckConclusion,
  type CheckLog,
  type CheckSummary,
  type Checkpoint,
  type CheckpointInput,
  type Comparison,
  type IssueFilter,
  type IssuePatch,
  type IssueRef,
  type IssueState,
  type IssueSummary,
  type MergeOutcome,
  type OpenPullRequestInput,
  type PullRequestDetail,
  type PullRequestRef,
  type SecurityFacts,
  type Snapshot,
  type UpdateOutcome,
  type VcsClient,
  type WorkflowRunRef,
} from "./types";
import {
  GITLAB_CHECKPOINT_PREFIX,
  GITLAB_CI_PATH,
  GITLAB_RUN_VARIABLE,
  GITLAB_RUNNER_JOB,
  SKIP_CI_LINE,
  gitlabInputVariable,
} from "@/lib/runner/gitlab-ci";
import { runTitle, type RunnerMode } from "@/lib/runner/workflow";

/**
 * gitlab.com REST (v4) over fetch, in the shape the rest of Formic already
 * talks to: a merge request is a "pull request" here, a pipeline job a
 * "check", Formic's own CI job a "workflow run".
 *
 * Where GitLab's API has no equivalent, the nearest thing that never
 * rewrites history:
 *  - Moving a branch to a commit (no "update ref" endpoint): checked to be a
 *    fast-forward first, then the branch is made again at that commit.
 *  - Merging one branch into another (no "merge" endpoint): a merge request
 *    from one into the other, merged with a merge commit.
 *  - Checkpoints (no refs outside branches): a `formic-checkpoints/` branch
 *    per card, its commit marked [skip ci] so saving it runs no pipeline.
 *  - Recording a merge (no way to add a parent to a commit): the runner's
 *    job pushes the real merge commit, so there is nothing left to record.
 */

const LOG_TAIL_LINES = 60;
/** How many of Formic's recent pipelines the run lookups read. */
const RECENT_PIPELINES = 20;
/** How long a merge request is given to work out whether it can merge. */
const MERGEABILITY_TRIES = 10;
const MERGEABILITY_WAIT_MS = 1_500;

interface RawMergeRequest {
  iid: number;
  web_url: string;
  state: string;
  title: string;
  sha: string | null;
  source_branch: string;
  target_branch: string;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  merge_status?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
}

interface RawIssue {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  labels: string[];
  web_url: string;
}

interface RawJob {
  id: number;
  name: string;
  status: string;
  web_url: string;
  allow_failure?: boolean;
  failure_reason?: string | null;
  duration?: number | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  pipeline?: { id: number; sha?: string; ref?: string };
}

interface RawPipeline {
  id: number;
  sha: string;
  ref: string;
  status: string;
  source?: string;
  web_url: string;
  created_at: string;
  updated_at: string;
}

const PENDING = new Set(["created", "waiting_for_resource", "preparing", "pending", "scheduled", "manual"]);
const RUNNING = new Set(["running"]);

/** A GitLab job or pipeline status, in the words Formic's checks use. */
function checkState(status: string, allowFailure = false): Pick<CheckSummary, "status" | "conclusion"> {
  if (PENDING.has(status)) return { status: "queued", conclusion: null };
  if (RUNNING.has(status)) return { status: "in_progress", conclusion: null };
  const conclusion: CheckConclusion =
    status === "success"
      ? "success"
      : status === "failed"
        ? allowFailure
          ? "neutral"
          : "failure"
        : status === "canceled" || status === "canceling"
          ? "cancelled"
          : status === "skipped"
            ? "skipped"
            : "neutral";
  return { status: "completed", conclusion };
}

/** A finished Formic job's conclusion, as GitHub would put it. */
function runConclusion(job: RawJob): string | null {
  const { status, conclusion } = checkState(job.status);
  if (status !== "completed") return null;
  if (job.failure_reason === "job_execution_timeout") return "timed_out";
  return conclusion;
}

function toDetail(raw: RawMergeRequest): PullRequestDetail {
  const status = raw.detailed_merge_status ?? raw.merge_status ?? "";
  const checking = ["checking", "unchecked", "preparing", "cannot_be_merged_recheck", "approvals_syncing"].includes(status);
  const conflicted = raw.has_conflicts === true || ["conflict", "broken_status", "need_rebase", "cannot_be_merged"].includes(status);
  return {
    number: raw.iid,
    url: raw.web_url,
    headSha: raw.sha ?? "",
    headBranch: raw.source_branch,
    baseBranch: raw.target_branch,
    state: raw.state === "opened" ? "open" : "closed",
    merged: raw.state === "merged",
    mergeable: checking ? null : !conflicted,
    title: raw.title,
  };
}

function toIssueSummary(raw: RawIssue): IssueSummary {
  return {
    number: raw.iid,
    // GitLab links issues by their number in the project, so that is the id too.
    id: raw.iid,
    title: raw.title,
    body: raw.description ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    labels: raw.labels,
    // GitLab's free tier has no parent issues; Formic links them instead.
    subIssue: false,
  };
}

function encodePath(path: string): string {
  return encodeURIComponent(path);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitLabClient implements VcsClient {
  readonly name = "gitlab";
  private readonly base: string;

  constructor(
    /** The project's path on gitlab.com, `group/project`. */
    readonly repoPath: string,
    /** The project owner's token: their access, their name on the commits. */
    private readonly token: string,
  ) {
    this.base = `/projects/${projectId(repoPath)}`;
  }

  private api<T>(path: string, init?: Parameters<typeof gl>[2]): Promise<T> {
    return gl<T>(this.token, `${this.base}${path}`, init);
  }

  /* Branches and files */

  async branchHead(branch: string): Promise<string | null> {
    const found = await this.api<{ commit: { id: string } } | null>(
      `/repository/branches/${encodePath(branch)}`,
      { allow404: true },
    );
    return found?.commit.id ?? null;
  }

  async ensureBranch(branch: string, fromRef: string): Promise<void> {
    if ((await this.branchHead(branch)) !== null) return;
    await this.api(`/repository/branches?branch=${encodePath(branch)}&ref=${encodePath(fromRef)}`, {
      method: "POST",
    });
  }

  async listFiles(ref: string): Promise<string[]> {
    const tree = await glPages<{ path: string; type: string }>(
      this.token,
      `${this.base}/repository/tree?ref=${encodePath(ref)}&recursive=true`,
      1000,
    );
    return tree.filter((t) => t.type === "blob").map((t) => t.path);
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    const text = await this.api<string | null>(
      `/repository/files/${encodePath(path)}/raw?ref=${encodePath(ref)}`,
      { allow404: true, raw: true },
    );
    return text;
  }

  async commitFile(branch: string, path: string, content: string, message: string): Promise<void> {
    const exists = (await this.readFile(path, branch)) !== null;
    await this.api("/repository/commits", {
      method: "POST",
      body: {
        branch,
        commit_message: message,
        actions: [{ action: exists ? "update" : "create", file_path: path, content }],
      },
    });
  }

  async moveBranch(branch: string, sha: string): Promise<void> {
    const current = await this.branchHead(branch);
    if (current === sha) return;
    if (current === null) {
      await this.api(`/repository/branches?branch=${encodePath(branch)}&ref=${encodePath(sha)}`, { method: "POST" });
      return;
    }
    // Only ever forward: the branch's commit must be where the new one came from.
    const base = await this.api<{ id: string } | null>(
      `/repository/merge_base?refs[]=${encodePath(current)}&refs[]=${encodePath(sha)}`,
      { allow404: true },
    );
    if (base?.id !== current) {
      throw new VcsError(`Refusing to move ${branch}: ${sha.slice(0, 7)} does not follow from where it is now.`, 422);
    }
    // GitLab has no endpoint that moves a branch, so it is made again at the
    // new commit. A protected branch refuses the delete, which is the refusal
    // wanted: Formic never moves those by hand.
    await this.api(`/repository/branches/${encodePath(branch)}`, { method: "DELETE" });
    await this.api(`/repository/branches?branch=${encodePath(branch)}&ref=${encodePath(sha)}`, { method: "POST" });
  }

  async deleteStagingBranch(branch: string): Promise<void> {
    if (!branch.startsWith(STAGING_PREFIX)) {
      throw new VcsError(`Refusing to delete ${branch}: only ${STAGING_PREFIX} branches.`);
    }
    await this.api(`/repository/branches/${encodePath(branch)}`, { method: "DELETE", allow404: true });
  }

  async countCommits(branch: string): Promise<number> {
    const commits = await glPages<unknown>(
      this.token,
      `${this.base}/repository/commits?ref_name=${encodePath(branch)}`,
      50,
    ).catch((e: unknown) => {
      if (e instanceof VcsError && e.status === 404) return [];
      throw e;
    });
    return commits.length;
  }

  async compare(base: string, head: string): Promise<Comparison> {
    const data = await this.api<{
      commit: { id: string } | null;
      commits: Array<{ id: string; message: string; created_at: string }>;
      diffs: Array<{ old_path: string; new_path: string; diff: string; renamed_file: boolean }>;
    }>(`/repository/compare?from=${encodePath(base)}&to=${encodePath(head)}&straight=false`);
    const files = new Set<string>();
    const patches: Array<{ path: string; patch: string }> = [];
    for (const d of data.diffs) {
      files.add(d.new_path);
      // A rename touches the path it left as well as the one it took.
      if (d.renamed_file || d.old_path !== d.new_path) files.add(d.old_path);
      if (d.diff) patches.push({ path: d.new_path, patch: d.diff });
    }
    const commits = [...data.commits].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return {
      files: [...files],
      messages: commits.map((c) => c.message),
      headSha: data.commit?.id ?? commits.at(-1)?.id ?? "",
      patches,
    };
  }

  async snapshot(ref: string, keep: Keep, budget: number): Promise<Snapshot> {
    const response = await fetch(
      `${GITLAB_API}${this.base}/repository/archive.tar.gz?sha=${encodePath(ref)}`,
      { headers: glHeaders(this.token), cache: "no-store" },
    ).catch((e: unknown) => {
      throw new VcsError(`Could not reach GitLab: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!response.ok || !response.body) {
      throw new VcsError(`GitLab would not give the archive of ${ref} (${response.status})`, response.status);
    }
    // GitLab's archives put every path under one `project-ref-sha/` folder, as GitHub's do.
    const gunzip = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(createGunzip());
    return untar(gunzip, keep, budget);
  }

  /* Merge requests */

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
    const created = await this.api<RawMergeRequest>("/merge_requests", {
      method: "POST",
      body: {
        source_branch: input.headBranch,
        target_branch: input.baseBranch,
        title: input.title,
        description: input.body,
        remove_source_branch: false,
      },
    });
    return toDetail(created);
  }

  async pullRequest(number: number): Promise<PullRequestDetail> {
    return toDetail(await this.api<RawMergeRequest>(`/merge_requests/${number}`));
  }

  async findPullRequest(headBranch: string): Promise<PullRequestRef | null> {
    const open = await this.api<RawMergeRequest[]>(
      `/merge_requests?state=opened&source_branch=${encodePath(headBranch)}`,
    );
    return open[0] ? toDetail(open[0]) : null;
  }

  async closeSupersededPulls(prefix: string, keepBranch: string, reason: string): Promise<number[]> {
    const open = await glPages<RawMergeRequest>(this.token, `${this.base}/merge_requests?state=opened`, 3);
    const stale = open.filter((m) => m.source_branch.startsWith(prefix) && m.source_branch !== keepBranch);
    for (const mr of stale) {
      await this.comment(mr.iid, reason);
      await this.api(`/merge_requests/${mr.iid}`, { method: "PUT", body: { state_event: "close" } });
    }
    return stale.map((m) => m.iid);
  }

  async retargetPullRequest(number: number, baseBranch: string): Promise<void> {
    await this.api(`/merge_requests/${number}`, { method: "PUT", body: { target_branch: baseBranch } });
  }

  async updateBranch(number: number): Promise<UpdateOutcome> {
    // GitLab's own "update" rebases, which rewrites history. Merge the target in instead.
    const mr = await this.pullRequest(number);
    return this.mergeBranch(mr.headBranch, mr.baseBranch);
  }

  async mergeBranch(base: string, head: string): Promise<UpdateOutcome> {
    const ahead = await this.api<{ commits: unknown[] }>(
      `/repository/compare?from=${encodePath(base)}&to=${encodePath(head)}&straight=false`,
    );
    if (ahead.commits.length === 0) return { ok: true, updated: false };

    // No endpoint merges one branch into another, so a merge request does,
    // with a merge commit, and is gone once it has.
    const title = `Bring ${head} into ${base}`;
    let mr: RawMergeRequest;
    try {
      mr = await this.api<RawMergeRequest>("/merge_requests", {
        method: "POST",
        body: { source_branch: head, target_branch: base, title, remove_source_branch: false },
      });
    } catch (e) {
      if (!(e instanceof VcsError) || e.status !== 409) throw e;
      const existing = await this.api<RawMergeRequest[]>(
        `/merge_requests?state=opened&source_branch=${encodePath(head)}&target_branch=${encodePath(base)}`,
      );
      if (!existing[0]) throw e;
      mr = existing[0];
    }
    const settled = await this.settle(mr.iid);
    if (settled.mergeable === false) {
      await this.api(`/merge_requests/${mr.iid}`, { method: "PUT", body: { state_event: "close" } }).catch(() => undefined);
      return { ok: false, reason: `${head} and ${base} conflict.`, conflict: true };
    }
    try {
      await this.api(`/merge_requests/${mr.iid}/merge`, {
        method: "PUT",
        body: { merge_commit_message: title, squash: false, should_remove_source_branch: false },
      });
      return { ok: true, updated: true };
    } catch (e) {
      if (!(e instanceof VcsError)) throw e;
      await this.api(`/merge_requests/${mr.iid}`, { method: "PUT", body: { state_event: "close" } }).catch(() => undefined);
      return { ok: false, reason: e.message, conflict: e.status === 406 };
    }
  }

  /** A merge request once GitLab has worked out whether it can merge, or as it stands after a while. */
  private async settle(number: number): Promise<PullRequestDetail> {
    let detail = await this.pullRequest(number);
    for (let i = 0; detail.mergeable === null && i < MERGEABILITY_TRIES; i++) {
      await sleep(MERGEABILITY_WAIT_MS);
      detail = await this.pullRequest(number);
    }
    return detail;
  }

  async bringsInBase(from: string, to: string, base: string): Promise<boolean> {
    try {
      const commit = await this.api<{ parent_ids: string[] }>(`/repository/commits/${encodePath(to)}`);
      const [first, second] = commit.parent_ids;
      if (commit.parent_ids.length !== 2 || first !== from || !second) return false;
      // The other parent is already on base: base is where they meet.
      const meet = await this.api<{ id: string } | null>(
        `/repository/merge_base?refs[]=${encodePath(base)}&refs[]=${encodePath(second)}`,
        { allow404: true },
      );
      return meet?.id === second;
    } catch (e) {
      if (e instanceof VcsError) return false;
      throw e;
    }
  }

  async merge(number: number, expectedHeadSha: string): Promise<MergeOutcome> {
    const attempt = (squash: boolean) =>
      this.api<RawMergeRequest>(`/merge_requests/${number}/merge`, {
        method: "PUT",
        body: { sha: expectedHeadSha, squash, should_remove_source_branch: false },
      });
    try {
      let merged: RawMergeRequest;
      try {
        merged = await attempt(true);
      } catch (e) {
        // A project that never squashes refuses the squash, not the merge.
        if (!(e instanceof VcsError) || !/squash/i.test(e.message)) throw e;
        merged = await attempt(false);
      }
      return merged.state === "merged"
        ? { ok: true, sha: merged.merge_commit_sha ?? merged.squash_commit_sha ?? merged.sha ?? expectedHeadSha }
        : { ok: false, reason: "GitLab declined the merge.", conflict: false };
    } catch (e) {
      if (!(e instanceof VcsError)) throw e;
      // 406: it cannot merge (a conflict); 409: the head moved; 405: not allowed yet.
      return { ok: false, reason: e.message, conflict: e.status === 406 || e.status === 409 };
    }
  }

  async recordMerge(sha: string, merged: string): Promise<string> {
    // The runner's job pushes the merge itself on GitLab, parents and all.
    const commit = await this.api<{ parent_ids: string[] }>(`/repository/commits/${encodePath(sha)}`);
    if (commit.parent_ids.includes(merged)) return sha;
    throw new VcsError(
      `GitLab cannot record ${sha.slice(0, 7)} as a merge of ${merged.slice(0, 7)} after the fact; the run must push the merge itself.`,
    );
  }

  async landCarried(sha: string): Promise<{ sha: string; files: string[] }> {
    // Nothing is ever carried on GitLab: a job may push changes to CI files.
    return { sha, files: [] };
  }

  async comment(number: number, body: string, on: "pull" | "issue" = "pull"): Promise<void> {
    const where = on === "issue" ? "issues" : "merge_requests";
    await this.api(`/${where}/${number}/notes`, { method: "POST", body: { body } });
  }

  /* Checks: the jobs of the pipelines that ran on a commit */

  private async jobsFor(sha: string): Promise<RawJob[]> {
    const pipelines = await this.api<RawPipeline[]>(`/pipelines?sha=${encodePath(sha)}&per_page=20`);
    const latest = new Map<string, RawJob>();
    // Newest pipeline first: a job's latest run is the one that counts.
    for (const p of pipelines) {
      const jobs = await this.api<RawJob[]>(`/pipelines/${p.id}/jobs?per_page=100&include_retried=false`);
      for (const job of jobs) {
        if (job.name === GITLAB_RUNNER_JOB) continue;
        if (!latest.has(job.name)) latest.set(job.name, job);
      }
    }
    return [...latest.values()];
  }

  async checksFor(sha: string): Promise<CheckSummary[]> {
    return (await this.jobsFor(sha)).map((job) => ({
      id: job.id,
      name: job.name,
      ...checkState(job.status, job.allow_failure),
      detailsUrl: job.web_url,
    }));
  }

  async hasCi(baseBranch: string): Promise<boolean> {
    const source = await this.readFile(GITLAB_CI_PATH, baseBranch).catch(() => "unreadable");
    if (source === null) return false;
    if (source === "unreadable") return true;
    try {
      const config = parseYaml(source) as Record<string, unknown> | null;
      if (!config || typeof config !== "object") return false;
      const reserved = new Set([
        "include", "stages", "variables", "workflow", "default", "image", "services",
        "cache", "before_script", "after_script", "spec", "pages",
      ]);
      const jobs = Object.keys(config).filter((k) => !reserved.has(k) && !k.startsWith("."));
      if (jobs.length > 0) return true;
      // Only includes: anything besides Formic's own file could be CI.
      const include = config.include;
      const entries = Array.isArray(include) ? include : include ? [include] : [];
      return entries.some((e) => !JSON.stringify(e).includes("formic-agent"));
    } catch {
      // Unreadable could be CI: wait for checks.
      return true;
    }
  }

  async checkLog(checkRunId: number): Promise<CheckLog> {
    const job = await this.api<RawJob>(`/jobs/${checkRunId}`);
    const tail = await this.jobLogTail(checkRunId);
    return { name: job.name, summary: tail, annotations: [] };
  }

  private async jobTrace(jobId: number): Promise<string | null> {
    return this.api<string | null>(`/jobs/${jobId}/trace`, { raw: true, allow404: true }).catch(() => null);
  }

  /** The last lines a job printed, or "" when there is no log. */
  private async jobLogTail(jobId: number): Promise<string> {
    const text = await this.jobTrace(jobId);
    if (!text) return "";
    const lines = text
      .split("\n")
      // GitLab's section markers and colours.
      .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/section_(start|end):\d+:[^\r]*\r?/g, "").trimEnd());
    const tail = lines.slice(-LOG_TAIL_LINES).join("\n").trim();
    return tail ? `End of the job's log:\n${tail}`.slice(-8_000) : "";
  }

  async branchRuns(branch: string): Promise<BranchRun[]> {
    const pipelines = await this.api<RawPipeline[]>(`/pipelines?ref=${encodePath(branch)}&per_page=50`);
    return pipelines.map((p) => {
      const { status, conclusion } = checkState(p.status);
      return {
        name: "pipeline",
        sha: p.sha,
        status,
        conclusion,
        attempt: 1,
        startedAt: p.created_at,
        updatedAt: p.updated_at,
        url: p.web_url,
      };
    });
  }

  async artifacts(branch: string, name: RegExp, keep: Keep, budget: number): Promise<ArtifactFiles | null> {
    const pipelines = await this.api<RawPipeline[]>(`/pipelines?ref=${encodePath(branch)}&per_page=10`);
    for (const p of pipelines.filter((p) => !PENDING.has(p.status) && !RUNNING.has(p.status))) {
      const jobs = await this.api<Array<RawJob & { artifacts_file?: { size?: number } | null }>>(
        `/pipelines/${p.id}/jobs?per_page=100`,
      );
      const wanted = jobs.filter((j) => j.artifacts_file && name.test(j.name) && (j.artifacts_file.size ?? 0) <= budget);
      if (wanted.length === 0) continue;
      const files = new Map<string, Buffer>();
      let left = budget;
      for (const job of wanted) {
        const zip = await glBytes(this.token, `${this.base}/jobs/${job.id}/artifacts`).catch(() => null);
        if (!zip) continue;
        const { files: inner } = unzip(zip, keep, left);
        for (const [path, bytes] of inner) {
          files.set(`${job.name}/${path}`, bytes);
          left -= bytes.length;
        }
      }
      return { runUrl: p.web_url, files };
    }
    return null;
  }

  async security(branch: string): Promise<SecurityFacts> {
    const none = { ok: false as const, reason: "GitLab's security reports are not read yet" };
    const [protection, settings] = await Promise.all([
      this.api<{ name: string } | null>(`/protected_branches/${encodePath(branch)}`, { allow404: true }).then(
        (found) => ({ ok: true as const, protected: found !== null, requiredChecks: [] as string[] }),
        (e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }),
      ),
      this.api<{ visibility: string }>("").then(
        (p) => ({ ok: true as const, visibility: p.visibility, features: {} as Record<string, string> }),
        (e: unknown) => ({ ok: false as const, reason: e instanceof Error ? e.message : String(e) }),
      ),
    ]);
    return { dependabot: none, secrets: none, codeScanning: none, protection, settings };
  }

  async actionsMachines(): Promise<ActionsMachines> {
    const [visibility, runners] = await Promise.all([
      this.api<{ visibility: string }>("").then(
        (p) => p.visibility !== "public",
        () => null,
      ),
      this.api<Array<{ description: string | null; status: string; active?: boolean }>>(
        "/runners?type=project_type&per_page=100",
      ).then(
        (list) => list.map((r) => ({ name: r.description ?? "runner", online: r.status === "online", busy: false, labels: [] })),
        () => null,
      ),
    ]);
    return { private: visibility, runners };
  }

  /* Issues */

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueRef> {
    const created = await this.api<RawIssue>("/issues", {
      method: "POST",
      body: { title: input.title, description: input.body, labels: input.labels.join(",") },
    });
    return { number: created.iid, id: created.iid, url: created.web_url };
  }

  async updateIssue(number: number, patch: IssuePatch): Promise<void> {
    await this.api(`/issues/${number}`, {
      method: "PUT",
      body: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { description: patch.body } : {}),
        ...(patch.labels !== undefined ? { labels: patch.labels.join(",") } : {}),
        ...(patch.state ? { state_event: patch.state === "closed" ? "close" : "reopen" } : {}),
      },
    });
  }

  async issues(state: IssueState, filter: IssueFilter = {}): Promise<IssueSummary[]> {
    const query = new URLSearchParams({ state: state === "open" ? "opened" : "closed", per_page: "100" });
    if (filter.labels?.length) query.set("labels", filter.labels.join(","));
    if (filter.since) query.set("updated_after", filter.since);
    return (await this.api<RawIssue[]>(`/issues?${query.toString()}`)).map(toIssueSummary);
  }

  async issue(number: number): Promise<IssueSummary | null> {
    const found = await this.api<RawIssue | null>(`/issues/${number}`, { allow404: true });
    return found ? toIssueSummary(found) : null;
  }

  async addSubIssue(parentNumber: number, childId: number): Promise<void> {
    // No parent issues on GitLab's free tier: the two are linked instead.
    const project = await this.api<{ id: number }>("");
    await this.api(`/issues/${parentNumber}/links`, {
      method: "POST",
      body: { target_project_id: project.id, target_issue_iid: childId },
    }).catch((e: unknown) => {
      // 409: already linked, which is all this asks for.
      if (!(e instanceof VcsError) || e.status !== 409) throw e;
    });
  }

  async ensureLabel(name: string, color: string, description: string): Promise<void> {
    try {
      await this.api("/labels", { method: "POST", body: { name, color: `#${color.replace(/^#/, "")}`, description } });
    } catch (e) {
      // 409: it already exists, which is all this asks for.
      if (!(e instanceof VcsError) || e.status !== 409) throw e;
    }
  }

  /* Formic's runs: its job in the pipelines it started */

  async dispatchWorkflow(_file: string, ref: string, inputs: Record<string, string>): Promise<void> {
    const variables = [
      { key: GITLAB_RUN_VARIABLE, value: "1", variable_type: "env_var" },
      ...Object.entries(inputs).map(([key, value]) => ({ key: gitlabInputVariable(key), value, variable_type: "env_var" })),
    ];
    await this.api(`/pipeline?ref=${encodePath(ref)}`, { method: "POST", body: { variables } });
  }

  async recentRuns(_file: string): Promise<Array<WorkflowRunRef & { id: number; title: string }>> {
    const pipelines = await this.api<RawPipeline[]>(`/pipelines?source=api&per_page=${RECENT_PIPELINES}`);
    const runs: Array<WorkflowRunRef & { id: number; title: string }> = [];
    for (const p of pipelines) {
      const variables = await this.api<Array<{ key: string; value: string }>>(`/pipelines/${p.id}/variables`).catch(
        () => [],
      );
      const value = (input: string) => variables.find((v) => v.key === gitlabInputVariable(input))?.value ?? "";
      if (!variables.some((v) => v.key === GITLAB_RUN_VARIABLE)) continue;
      const jobs = await this.api<RawJob[]>(`/pipelines/${p.id}/jobs?per_page=100`).catch(() => []);
      const job = jobs.find((j) => j.name === GITLAB_RUNNER_JOB);
      if (!job) continue;
      const conclusion = runConclusion(job);
      runs.push({
        id: job.id,
        title: runTitle(value("mode") as RunnerMode, value("ticket"), value("job")),
        status: conclusion === null ? "in_progress" : "completed",
        conclusion,
        url: job.web_url,
      });
    }
    return runs;
  }

  async findRun(file: string, title: string): Promise<WorkflowRunRef | null> {
    const run = (await this.recentRuns(file)).find((r) => r.title === title);
    return run ? { status: run.status, conclusion: run.conclusion, url: run.url } : null;
  }

  async cancelRun(runId: number): Promise<void> {
    await this.api(`/jobs/${runId}/cancel`, { method: "POST" });
  }

  async rerunFailedJobs(runId: number): Promise<void> {
    await this.api(`/jobs/${runId}/retry`, { method: "POST" });
  }

  async runLog(runUrl: string): Promise<string | null> {
    const id = /\/-\/jobs\/(\d+)/.exec(runUrl)?.[1];
    return id ? this.jobTrace(Number(id)) : null;
  }

  async runTimeout(runUrl: string): Promise<string | null> {
    const id = /\/-\/jobs\/(\d+)/.exec(runUrl)?.[1];
    if (!id) return null;
    const job = await this.api<RawJob>(`/jobs/${id}`).catch(() => null);
    if (!job || job.failure_reason !== "job_execution_timeout") return null;
    const minutes = Math.round((job.duration ?? 0) / 60);
    return `${minutes}m0s`;
  }

  /**
   * What Formic's job needs from the project, switched on as the person the
   * board acts for (a Maintainer can): pushing its work with its own job
   * token, and pipelines started with variables, which carry the run's
   * inputs. Refused for anyone else, with what to ask a Maintainer for.
   */
  async prepareRunner(): Promise<void> {
    try {
      await this.api("", {
        method: "PUT",
        body: {
          ci_push_repository_for_job_token_allowed: true,
          ci_pipeline_variables_minimum_override_role: "developer",
        },
      });
    } catch (e) {
      if (e instanceof VcsError && (e.status === 400 || e.status === 403)) {
        throw new VcsError(
          "GitLab: Formic could not change this project's CI settings, which takes a Maintainer. Ask one to turn on " +
            "\"Allow Git push requests to the repository\" (Settings, CI/CD, Job token permissions) and to let " +
            "Developers run pipelines with variables (Settings, CI/CD, Variables), then try again.",
          403,
        );
      }
      throw e;
    }
  }

  /** One webhook for Formic's job events at `url`, made or brought up to date. */
  async ensureWebhook(url: string, token: string): Promise<void> {
    const hooks = await this.api<Array<{ id: number; url: string }>>("/hooks?per_page=100");
    const body = {
      url,
      token,
      job_events: true,
      push_events: false,
      pipeline_events: false,
      merge_requests_events: false,
      enable_ssl_verification: true,
    };
    const found = hooks.find((h) => h.url === url);
    if (found) await this.api(`/hooks/${found.id}`, { method: "PUT", body });
    else await this.api("/hooks", { method: "POST", body });
  }

  /* Checkpoints: one branch per card, its commit on the work's base */

  async saveCheckpoint(card: string, input: CheckpointInput): Promise<string> {
    const branch = `${GITLAB_CHECKPOINT_PREFIX}${card}`;
    const existing = new Set(await this.listFiles(input.base));
    const actions = [
      // GitLab makes no symlinks through its API; their text is kept as it is.
      ...input.files.map((f) => ({
        action: existing.has(f.path) ? "update" : "create",
        file_path: f.path,
        content: f.content,
        encoding: "base64",
        execute_filemode: f.mode === "100755",
      })),
      ...input.deleted.filter((p) => existing.has(p)).map((p) => ({ action: "delete", file_path: p })),
    ];
    const commit = await this.api<{ id: string }>("/repository/commits", {
      method: "POST",
      body: {
        branch,
        start_sha: input.base,
        force: true,
        commit_message: `${input.message}\n\n${SKIP_CI_LINE}`,
        actions,
      },
    });
    return commit.id;
  }

  async checkpoint(card: string): Promise<Checkpoint | null> {
    const sha = await this.branchHead(`${GITLAB_CHECKPOINT_PREFIX}${card}`);
    if (!sha) return null;
    const commit = await this.api<{ message: string; parent_ids: string[] }>(`/repository/commits/${sha}`);
    const parent = commit.parent_ids[0];
    const message = commit.message
      .split("\n")
      .filter((line) => line.trim() !== SKIP_CI_LINE)
      .join("\n")
      .trimEnd();
    return parent ? { sha, parent, message } : null;
  }

  async deleteCheckpoint(card: string): Promise<void> {
    await this.api(`/repository/branches/${encodePath(`${GITLAB_CHECKPOINT_PREFIX}${card}`)}`, {
      method: "DELETE",
      allow404: true,
    });
  }
}
