import { describe, expect, it } from "vitest";
import { escalateStoryPoints } from "./escalate";

describe("escalateStoryPoints", () => {
  it.each([
    [1, 2],
    [2, 3],
    [3, 5],
    [5, 8],
    [8, 13],
  ])("raises %i points to %i the first time", (from, to) => {
    expect(escalateStoryPoints({ storyPoints: from, enabled: true, escalatedAt: null })).toEqual({
      kind: "escalate",
      from,
      to,
    });
  });

  it("treats an unestimated ticket as one point", () => {
    expect(escalateStoryPoints({ storyPoints: null, enabled: true, escalatedAt: null })).toMatchObject({ to: 2 });
  });

  it("leaves points alone and says so when already escalated", () => {
    expect(
      escalateStoryPoints({ storyPoints: 8, enabled: true, escalatedAt: "2026-01-01T00:00:00Z" }),
    ).toEqual({ kind: "repointed-twice", storyPoints: 8 });
  });

  it("does nothing when disabled", () => {
    expect(escalateStoryPoints({ storyPoints: 5, enabled: false, escalatedAt: null })).toEqual({ kind: "none" });
    expect(escalateStoryPoints({ storyPoints: 5, enabled: false, escalatedAt: "x" })).toEqual({ kind: "none" });
  });

  it("does nothing past the largest value", () => {
    expect(escalateStoryPoints({ storyPoints: 13, enabled: true, escalatedAt: null })).toEqual({ kind: "none" });
  });
});
