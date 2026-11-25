import { describe, expect, it } from "vitest";
import { STATUS_LABEL, STATUS_TONE, statusLabel, statusTone } from "./tokens";

describe("statusLabel / statusTone", () => {
  it("name an agent's question Question, in plum", () => {
    const reason = "Question: Which db?\nThe PM is waiting for your answer.";
    expect(statusLabel("blocked", reason)).toBe("Question");
    expect(statusTone("blocked", reason)).toBe("plum");
  });

  it("leave any other reason, or none, as the status says", () => {
    for (const reason of [undefined, null, "", "CI failed"]) {
      expect(statusLabel("blocked", reason)).toBe(STATUS_LABEL.blocked);
      expect(statusTone("blocked", reason)).toBe(STATUS_TONE.blocked);
    }
  });
});
