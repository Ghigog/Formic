import { describe, expect, it } from "vitest";
import { classifyNotice } from "./notice";

describe("classifyNotice", () => {
  it("makes a failed ticket a warning with a title and both descriptions", () => {
    const n = classifyNotice({ status: "failed", stalledIn: "in_progress", blockedReason: "Tests failed" });
    expect(n).toEqual({
      severity: "warning",
      title: expect.any(String),
      shortDescription: "Tests failed",
      longDescription: "Tests failed",
    });
    expect(n?.title).not.toBe("");
  });

  it("makes a scope authorization request an alert", () => {
    const n = classifyNotice({
      status: "blocked",
      stalledIn: "todo",
      blockedReason: "Needs files outside its scope: `src/a.ts`. Allow them in its chat to carry on.",
    });
    expect(n?.severity).toBe("alert");
  });

  it("makes any other pause that waits for a person an alert", () => {
    const n = classifyNotice({ status: "blocked", stalledIn: "in_progress", blockedReason: "This agent has no API key." });
    expect(n?.severity).toBe("alert");
  });

  it("gives no notice for a dependency wait", () => {
    expect(classifyNotice({ status: "waiting", stalledIn: null, blockedReason: null })).toBeNull();
  });

  it("gives no notice for a ticket that is not stalled", () => {
    expect(classifyNotice({ status: "running", stalledIn: null, blockedReason: null })).toBeNull();
  });

  it("splits a multi-line reason into a first line and the full text", () => {
    const reason = "Run failed\nline two\nline three";
    const n = classifyNotice({ status: "failed", stalledIn: "in_progress", blockedReason: reason });
    expect(n?.shortDescription).toBe("Run failed");
    expect(n?.longDescription).toBe(reason);
  });
});
