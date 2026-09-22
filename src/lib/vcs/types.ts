/**
 * The version-control boundary.
 *
 * Everything the agents do to GitHub goes through this: open a pull request,
 * read its checks, bring it up to date, merge it. Narrow on purpose — the
 * surface an autonomous agent can reach is a security property, not an
 * implementation detail. There is no force-push here and no branch deletion,
 * because nothing in the MVP should be able to perform either.
 */

export interface PullRequestRef {
  number: number;
  url: string;
  headSha: string;
  headBranch: string;
  baseBranch: string;
}

export interface PullRequestDetail extends PullRequestRef {
  state: "open" | "closed";
  merged: boolean;
  /** Null while GitHub is still computing mergeability. */
  mergeable: boolean | null;
  title: string;
}

export type CheckConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped"
  | "stale";

export interface CheckSummary {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: CheckConclusion | null;
  detailsUrl: string | null;
}

/** What the Reviewer Agent is given to diagnose a red check. */
export interface CheckLog {
  name: string;
  summary: string;
  /** Per-line annotations, the closest thing the API gives to a stack trace. */
  annotations: Array<{ path: string; line: number | null; message: string }>;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: string; conflict: boolean };

export type UpdateOutcome =
  | { ok: true; updated: boolean }
  | { ok: false; reason: string; conflict: boolean };

export interface OpenPullRequestInput {
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface VcsClient {
  readonly name: string;
  /** Creates `branch` from `fromRef` when it does not already exist. */
  ensureBranch(branch: string, fromRef: string): Promise<void>;
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef>;
  pullRequest(number: number): Promise<PullRequestDetail>;
  checksFor(sha: string): Promise<CheckSummary[]>;
  checkLog(checkRunId: number): Promise<CheckLog>;
  /** Merges the base branch into the PR head. Never rewrites history. */
  updateBranch(number: number): Promise<UpdateOutcome>;
  /** `expectedHeadSha` guards against merging a commit nobody reviewed. */
  merge(number: number, expectedHeadSha: string): Promise<MergeOutcome>;
  comment(number: number, body: string): Promise<void>;
}

export class VcsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VcsError";
  }
}

/** The author every agent commit is attributed to. */
export const AGENT_COMMIT_AUTHOR = {
  name: "Formic Agent",
  email: "formic-agent@users.noreply.github.com",
} as const;

/**
 * Whether a commit is one of ours. The fix loop reacts to CI, and CI runs on
 * the commits the fix loop pushes; without an authorship gate that is a
 * perpetual motion machine with a credit card attached.
 */
export function isAgentAuthored(email: string | null | undefined): boolean {
  return email?.toLowerCase() === AGENT_COMMIT_AUTHOR.email;
}
