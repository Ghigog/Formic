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
  type IssuePatch,
  type IssueRef,
  STAGING_PREFIX,
} from "./types";

/**
 * A GitHub that only exists in this process.
 *
 * With no GITHUB_TOKEN there is nothing to clone and nowhere to push, and the
 * MVP's promise is that the board still runs end to end. This keeps that true:
 * pull requests get numbers, checks go green, merges succeed, and every one of
 * them is visibly labelled a mock in the UI rather than pretending.
 */

interface MockPull extends PullRequestDetail {
  checks: CheckSummary[];
}

declare global {
  // eslint-disable-next-line no-var
  var __formicMockPulls: Map<number, MockPull> | undefined;
}

function pulls(): Map<number, MockPull> {
  if (!globalThis.__formicMockPulls) globalThis.__formicMockPulls = new Map();
  return globalThis.__formicMockPulls;
}

/** Branches, files, secrets and dispatches: the rest of the mock repository. */
interface MockRepo {
  /** Branch name to head sha. */
  branches: Map<string, string>;
  /** `${ref}:${path}` to file text. */
  files: Map<string, string>;
  secrets: Map<string, string>;
  dispatches: Array<{ file: string; ref: string; inputs: Record<string, string> }>;
  /** Head sha to what that commit changed relative to its base. */
  commits: Map<string, { files: string[]; message: string }>;
  issues: Map<number, MockIssue>;
  labels: Set<string>;
  /** Comments by pull request or issue number. */
  comments: Map<number, string[]>;
}

export interface MockIssue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  subIssues: number[];
}

function repo(): MockRepo {
  const g = globalThis as { __formicMockRepo?: MockRepo };
  g.__formicMockRepo ??= {
    branches: new Map(),
    files: new Map(),
    secrets: new Map(),
    dispatches: [],
    commits: new Map(),
    issues: new Map(),
    labels: new Set(),
    comments: new Map(),
  };
  return g.__formicMockRepo;
}

let nextNumber = 1000;
/** Apart from pull request numbers, so tests that count those are unaffected. */
let nextIssue = 5000;

function fakeSha(): string {
  return Array.from({ length: 40 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)],
  ).join("");
}

export class MockVcsClient implements VcsClient {
  readonly name = "mock";

  constructor(
    private readonly repoFullName: string,
    /** Set false to make the first check fail, exercising the fix loop. */
    private readonly checksPass = true,
  ) {}

  async ensureBranch(): Promise<void> {}

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestRef> {
    const number = ++nextNumber;
    const pull: MockPull = {
      number,
      url: `https://github.com/${this.repoFullName}/pull/${number}`,
      headSha: fakeSha(),
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      state: "open",
      merged: false,
      mergeable: true,
      title: input.title,
      checks: [],
    };
    pull.checks = [
      {
        id: number,
        name: "ci / test",
        status: "completed",
        conclusion: this.checksPass ? "success" : "failure",
        detailsUrl: null,
      },
    ];
    pulls().set(number, pull);
    return pull;
  }

  async pullRequest(number: number): Promise<PullRequestDetail> {
    const pull = pulls().get(number);
    if (!pull) throw new Error(`No mock pull request ${number}.`);
    return pull;
  }

  async checksFor(sha: string): Promise<CheckSummary[]> {
    for (const pull of pulls().values()) {
      if (pull.headSha === sha) return pull.checks;
    }
    return [];
  }

  async checkLog(checkRunId: number): Promise<CheckLog> {
    return {
      name: "ci / test",
      summary:
        "FAIL src/lib/example.test.ts\n  ● example › returns the sum\n\n    expected 3, received 2",
      annotations: [
        {
          path: "src/lib/example.ts",
          line: 12,
          message: `Mock failure for check run ${checkRunId}.`,
        },
      ],
    };
  }

  async updateBranch(): Promise<UpdateOutcome> {
    return { ok: true, updated: false };
  }

  async merge(number: number, expectedHeadSha: string): Promise<MergeOutcome> {
    const pull = pulls().get(number);
    if (!pull) return { ok: false, reason: "Unknown pull request.", conflict: false };
    if (pull.headSha !== expectedHeadSha) {
      return { ok: false, reason: "Head moved since it was read.", conflict: true };
    }
    pull.merged = true;
    pull.state = "closed";
    return { ok: true, sha: fakeSha() };
  }

  async comment(number: number, body: string): Promise<void> {
    const list = repo().comments.get(number) ?? [];
    list.push(body);
    repo().comments.set(number, list);
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<IssueRef> {
    const number = nextIssue++;
    const issue: MockIssue = { number, id: number * 10, state: "open", subIssues: [], ...input };
    repo().issues.set(number, issue);
    return { number, id: issue.id, url: `https://github.com/${this.repoFullName}/issues/${number}` };
  }

  async updateIssue(number: number, patch: IssuePatch): Promise<void> {
    const issue = repo().issues.get(number);
    if (!issue) throw new Error(`No mock issue ${number}.`);
    Object.assign(issue, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  }

  async addSubIssue(parentNumber: number, childId: number): Promise<void> {
    const parent = repo().issues.get(parentNumber);
    const child = [...repo().issues.values()].find((i) => i.id === childId);
    if (!parent || !child) throw new Error("No such mock issue.");
    parent.subIssues.push(child.number);
  }

  async ensureLabel(name: string): Promise<void> {
    repo().labels.add(name);
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    return repo().files.get(`${ref}:${path}`) ?? null;
  }

  async commitFile(branch: string, path: string, content: string, _message: string): Promise<void> {
    repo().files.set(`${branch}:${path}`, content);
    repo().branches.set(branch, fakeSha());
  }

  async findPullRequest(headBranch: string): Promise<PullRequestRef | null> {
    for (const pull of pulls().values()) {
      if (pull.headBranch === headBranch && pull.state === "open") return pull;
    }
    return null;
  }

  async setSecret(name: string, value: string): Promise<void> {
    repo().secrets.set(name, value);
  }

  async dispatchWorkflow(file: string, ref: string, inputs: Record<string, string>): Promise<void> {
    repo().dispatches.push({ file, ref, inputs });
  }

  async compare(_base: string, head: string): Promise<Comparison> {
    const sha = repo().branches.get(head) ?? head;
    const commit = repo().commits.get(sha);
    return { files: commit?.files ?? [], messages: commit ? [commit.message] : [], headSha: sha };
  }

  async moveBranch(branch: string, sha: string): Promise<void> {
    repo().branches.set(branch, sha);
    // A PR from this branch now points at the new head, as on GitHub.
    for (const pull of pulls().values()) {
      if (pull.headBranch === branch) pull.headSha = sha;
    }
  }

  async deleteStagingBranch(branch: string): Promise<void> {
    if (!branch.startsWith(STAGING_PREFIX)) throw new Error(`Refusing to delete ${branch}.`);
    repo().branches.delete(branch);
  }

  /* Test seams for the runner. */

  /** What an Actions run pushed: a staging branch with these changes. */
  static stage(branch: string, files: string[], message: string): string {
    const sha = fakeSha();
    repo().branches.set(branch, sha);
    repo().commits.set(sha, { files, message });
    return sha;
  }

  static runner(): MockRepo {
    return repo();
  }

  /** Test seam: flip a mock PR's checks and hand back the head sha. */
  static setChecks(number: number, conclusion: CheckSummary["conclusion"]): string {
    const pull = pulls().get(number);
    if (!pull) throw new Error(`No mock pull request ${number}.`);
    pull.checks = pull.checks.map((c) => ({
      ...c,
      status: "completed",
      conclusion,
    }));
    return pull.headSha;
  }

  static reset(): void {
    pulls().clear();
    (globalThis as { __formicMockRepo?: MockRepo }).__formicMockRepo = undefined;
  }
}
