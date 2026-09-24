import { describe, expect, it } from "vitest";
import { checkHandoff, handoffFromSummary, handoffSection, withoutHandoff } from "./handoff";

const summary = [
  "T-1: Add Stripe checkout",
  "",
  "Adds the checkout route.",
  "",
  "For you:",
  "- Add STRIPE_SECRET_KEY to the Vercel project's environment variables",
  "- Run `npm run db:push` against production",
  "",
  "Plan:",
  "- [x] Add the route",
].join("\n");

describe("handoffFromSummary", () => {
  it("reads the steps under For you", () => {
    expect(handoffFromSummary(summary)).toEqual([
      "Add STRIPE_SECRET_KEY to the Vercel project's environment variables",
      "Run `npm run db:push` against production",
    ]);
  });

  it("is empty when there is no section", () => {
    expect(handoffFromSummary("T-1: Fix a typo\n\nPlan:\n- [x] Fix it")).toEqual([]);
  });
});

describe("withoutHandoff", () => {
  it("drops the section and keeps the rest", () => {
    expect(withoutHandoff(summary)).toBe(
      ["T-1: Add Stripe checkout", "", "Adds the checkout route.", "", "Plan:", "- [x] Add the route"].join("\n"),
    );
  });
});

describe("checkHandoff", () => {
  it("keeps non-empty strings only", () => {
    expect(checkHandoff([" Set a secret ", "", 3, null])).toEqual(["Set a secret"]);
    expect(checkHandoff("Set a secret")).toEqual([]);
  });
});

describe("handoffSection", () => {
  it("lists every ticket's steps as a checklist", () => {
    expect(handoffSection([{ key: "T-1", steps: ["Set a secret"] }, { key: "T-2", steps: [] }])).toContain(
      "- [ ] Set a secret (T-1)",
    );
  });

  it("is empty when no ticket has steps", () => {
    expect(handoffSection([{ key: "T-1", steps: [] }])).toBe("");
  });
});
