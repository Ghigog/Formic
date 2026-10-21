import { describe, expect, it } from "vitest";

import {
  checkFollowUps,
  followUpsFromSummary,
  followUpsSection,
  mergeFollowUps,
  MAX_FOLLOW_UPS,
  type FollowUp,
} from "./follow-ups";

const summary = [
  "EPIC-99-T9: Raise vitest coverage thresholds to measured values",
  "",
  "Thresholds set to the measured floor.",
  "",
  "Follow-ups:",
  "- Raise branch coverage to 78% (5 pt): about 540 branches are uncovered, far more than this ticket's estimate.",
  "- Fix order-dependent tests: scouts.test.ts fails when shuffled.",
  "",
  "Plan:",
  "- [x] Set thresholds",
].join("\n");

describe("followUpsFromSummary", () => {
  it("reads each follow-up's title, estimate and reason", () => {
    expect(followUpsFromSummary(summary)).toEqual([
      {
        title: "Raise branch coverage to 78%",
        why: "about 540 branches are uncovered, far more than this ticket's estimate.",
        points: 5,
      },
      { title: "Fix order-dependent tests", why: "scouts.test.ts fails when shuffled.", points: null },
    ]);
  });

  it("is empty without the section", () => {
    expect(followUpsFromSummary("T-1: Done\n\nAll of it.")).toEqual([]);
  });

  it("drops an estimate off the Fibonacci scale", () => {
    expect(followUpsFromSummary("Follow-ups:\n- Big job (4 pt): too big")[0]?.points).toBeNull();
  });

  it("reads back what followUpsSection writes", () => {
    const followUps = followUpsFromSummary(summary);
    expect(followUpsFromSummary(`Done.\n\n${followUpsSection(followUps)}`)).toEqual(followUps);
  });
});

describe("checkFollowUps", () => {
  it("keeps well-formed entries and drops the rest", () => {
    expect(
      checkFollowUps([
        { title: " Add tests ", why: " Too many for this ticket. ", points: 3 },
        { title: "", why: "No title", points: 1 },
        { why: "No title at all" },
        "not an object",
      ]),
    ).toEqual([{ title: "Add tests", why: "Too many for this ticket.", points: 3 }]);
  });

  it("is empty for anything but a list", () => {
    expect(checkFollowUps(null)).toEqual([]);
  });
});

describe("mergeFollowUps", () => {
  it("adds new titles once, ignoring case, up to the cap", () => {
    const had: FollowUp[] = [{ title: "Add tests", why: "", points: null }];
    const more: FollowUp[] = [
      { title: "add TESTS", why: "again", points: 2 },
      ...Array.from({ length: MAX_FOLLOW_UPS }, (_, i) => ({ title: `Job ${i}`, why: "", points: null })),
    ];
    const merged = mergeFollowUps(had, more);
    expect(merged).toHaveLength(MAX_FOLLOW_UPS);
    expect(merged[0]).toBe(had[0]);
    expect(merged.filter((f) => f.title.toLowerCase() === "add tests")).toHaveLength(1);
  });
});
