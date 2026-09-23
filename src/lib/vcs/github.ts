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
  STAGING_PREFIX,
  VcsError,
} from "./types";

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
}
