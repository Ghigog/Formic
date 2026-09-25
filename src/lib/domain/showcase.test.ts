import { describe, expect, it } from "vitest";
import { showcaseHeadline } from "./showcase";

describe("showcaseHeadline", () => {
  it("takes the opening sentence and none of the steps", () => {
    expect(
      showcaseHeadline("Teams can now invite teammates, so onboarding takes a minute.\n\n## See it\n\n1. Open Settings."),
    ).toBe("Teams can now invite teammates, so onboarding takes a minute.");
  });

  it("passes over the steps that are the person's own", () => {
    const md = [
      "## For you",
      "",
      "Steps no agent could take. They happen outside the repository, so they are yours:",
      "",
      "- [ ] Set STRIPE_KEY (T-1)",
      "",
      "Checkout works end to end.",
      "",
      "## See it",
    ].join("\n");
    expect(showcaseHeadline(md)).toBe("Checkout works end to end.");
  });

  it("reads an older showcase that opened with a heading", () => {
    expect(showcaseHeadline("# Board foundations\n\nA **working** board.\n\n## What shipped\n\n- a")).toBe(
      "A working board.",
    );
  });

  it("has nothing to say for an empty one", () => {
    expect(showcaseHeadline("## See it\n\n1. Open it.")).toBeNull();
  });
});
