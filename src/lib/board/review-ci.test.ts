import { describe, expect, it } from "vitest";

import { ciState, seedReviewCi } from "./review-ci";
import { makeCard } from "@/test/cards";
import type { CheckSummary, VcsClient } from "@/lib/vcs/types";

const check = (status: CheckSummary["status"], conclusion: CheckSummary["conclusion"]): CheckSummary => ({
  id: 1,
  name: "ci",
  status,
  conclusion,
  detailsUrl: null,
});

describe("ciState", () => {
  it("maps checks the way the review pipeline publishes them", () => {
    expect(ciState([])).toBe("none");
    expect(ciState([check("completed", "success"), check("completed", "skipped")])).toBe("passing");
    expect(ciState([check("completed", "failure")])).toBe("failing");
    expect(ciState([check("in_progress", null), check("completed", "success")])).toBe("pending");
    expect(ciState([check("completed", "cancelled")])).toBe("pending");
  });
});

describe("seedReviewCi", () => {
  const fake = (checks: Record<string, CheckSummary[] | Error>) =>
    ({
      pullRequest: async (n: number) => ({ headSha: `sha${n}` }),
      checksFor: async (sha: string) => {
        const r = checks[sha];
        if (r instanceof Error) throw r;
        return r ?? [];
      },
    }) as unknown as VcsClient;

  it("seeds each review card from its pull request's checks and skips failed lookups", async () => {
    const a = makeCard({ status: "review", prNumber: 1 });
    const b = makeCard({ status: "review", prNumber: 2 });
    const c = makeCard({ status: "review", prNumber: 3 });
    const running = makeCard({ status: "running", prNumber: 4 });
    const client = fake({
      sha1: [check("completed", "success")],
      sha2: [check("queued", null)],
      sha3: new Error("rate limited"),
    });
    expect(await seedReviewCi(client, [a, b, c, running])).toEqual({
      [a.id]: { ci: "passing" },
      [b.id]: { ci: "pending" },
    });
  });
});
