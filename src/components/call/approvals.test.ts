import { describe, expect, it } from "vitest";

import { mergeHint, MERGE_HINT, spokenDecision } from "./approvals";

const ticket = { summary: "Add T-1", action: { type: "create_ticket" } };
const done = { summary: "Move T-1 to Done", action: { type: "move_card", key: "T-1", to: "done" } };

describe("spokenDecision", () => {
  it.each(["yes", "Yes, do it", "go ahead", "Yes!", "yes do it."])("approves on %s", (t) => {
    expect(spokenDecision(t, ticket)).toBe("approve");
  });
  it.each(["no", "No.", "no thanks"])("dismisses on %s", (t) => {
    expect(spokenDecision(t, ticket)).toBe("dismiss");
  });
  it("ignores anything else", () => {
    expect(spokenDecision("what does it cost", ticket)).toBe("none");
    expect(spokenDecision("yes but later", ticket)).toBe("none");
  });
  it("takes a move to Done as approved only on 'yes, merge it'", () => {
    expect(spokenDecision("yes", done)).toBe("none");
    expect(spokenDecision("go ahead", done)).toBe("none");
    expect(spokenDecision("yes, merge it", done)).toBe("approve");
    expect(spokenDecision("no", done)).toBe("dismiss");
  });
  it("asks for 'yes, merge it' after a plain yes", () => {
    expect(mergeHint("yes", done)).toBe(MERGE_HINT);
    expect(mergeHint("yes, merge it", done)).toBeNull();
    expect(mergeHint("yes", ticket)).toBeNull();
  });
});
