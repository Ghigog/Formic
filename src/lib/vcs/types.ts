/**
 * The version-control boundary.
 *
 * Everything the agents do to GitHub goes through this: open a pull request,
 * read its checks, bring it up to date, merge it. Narrow on purpose — the
 * surface an autonomous agent can reach is a security property, not an
 * implementation detail. There is no force-push here, and the only branches
 * that can be deleted are Formic's own staging branches.
 */

/** Branches the cloud runner pushes to. The only ones Formic may delete. */
export const STAGING_PREFIX = "formic-staging/";

export interface Comparison {
  /** Paths changed between the two refs. */
  files: string[];
  /** Commit messages on the head side, oldest first. */
  messages: string[];
  headSha: string;
}

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

export interface WorkflowRunRef {
  status: string;
  /** Null until it completes. */
  conclusion: string | null;
  url: string;
}

export interface IssueRef {
  number: number;
  /** GitHub's internal id, which linking a sub-issue needs. */
  id: number;
  url: string;
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  /** Replaces every label on the issue. */
  labels?: string[];
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
  /** Comments on a pull request or an issue: they share numbers. */
  comment(number: number, body: string): Promise<void>;

  /* Issues: every Epic and ticket is tracked as one, for people on GitHub. */

  createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueRef>;
  updateIssue(number: number, patch: IssuePatch): Promise<void>;
  /** Files an issue under a parent, by the child's internal id. */
  addSubIssue(parentNumber: number, childId: number): Promise<void>;
  /** Creates a label when the repository does not have it yet. */
  ensureLabel(name: string, color: string, description: string): Promise<void>;

  /* The cloud runner: CLI agents that work in the repository's own Actions. */

  /** Every file path on a ref, capped by GitHub at about 100,000. */
  listFiles(ref: string): Promise<string[]>;
  /** A file's text on a ref, or null when it is not there. */
  readFile(path: string, ref: string): Promise<string | null>;
  /** Creates or replaces one file on a branch, as one commit. */
  commitFile(branch: string, path: string, content: string, message: string): Promise<void>;
  /** The open pull request from a branch, if there is one. */
  findPullRequest(headBranch: string): Promise<PullRequestRef | null>;
  /** Stores an Actions secret, encrypted to the repository's key. */
  setSecret(name: string, value: string): Promise<void>;
  dispatchWorkflow(file: string, ref: string, inputs: Record<string, string>): Promise<void>;
  /**
   * A recent dispatched run of a workflow, found by its title. For when the
   * webhook that reports it finishing never arrives.
   */
  findRun(file: string, title: string): Promise<WorkflowRunRef | null>;
  /**
   * The log of a finished run's failed job, by the run's URL, or null when
   * there is none to read.
   */
  runLog(runUrl: string): Promise<string | null>;
  compare(base: string, head: string): Promise<Comparison>;
  /** Creates `branch` at `sha`, or fast-forwards it there. Never forces. */
  moveBranch(branch: string, sha: string): Promise<void>;
  /** Deletes a staging branch. Refuses any branch outside STAGING_PREFIX. */
  deleteStagingBranch(branch: string): Promise<void>;
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
