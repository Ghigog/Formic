import {
  type CheckLog,
  type CheckSummary,
  type MergeOutcome,
  type OpenPullRequestInput,
  type PullRequestDetail,
  type PullRequestRef,
  type UpdateOutcome,
  type VcsClient,
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

let nextNumber = 1000;

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

  async comment(): Promise<void> {}

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
  }
}
