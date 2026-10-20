import { describe, expect, it } from "vitest";
import { classifyNotice } from "./notice";

describe("classifyNotice", () => {
  it("makes a failed ticket a warning with a title and both descriptions", () => {
    const n = classifyNotice({ status: "failed", stalledIn: "in_progress", blockedReason: "Tests failed" });
    expect(n).toEqual({
      severity: "warning",
      title: expect.any(String),
      shortDescription: "Tests failed",
      longDescription: "",
    });
    expect(n?.title).not.toBe("");
  });

  it("splits a failure into its type and its detail without repeating the type", () => {
    const n = classifyNotice({
      status: "failed",
      stalledIn: "in_progress",
      blockedReason: "The agent changed nothing\nNothing to add.\nLog: https://x/1",
    });
    expect(n).toMatchObject({
      shortDescription: "The agent changed nothing",
      longDescription: "Nothing to add.\nLog: https://x/1",
    });
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

  it("splits a multi-line reason into a first line and the remainder", () => {
    const reason = "Run failed\nline two\nline three";
    const n = classifyNotice({ status: "failed", stalledIn: "in_progress", blockedReason: reason });
    expect(n?.shortDescription).toBe("Run failed");
    expect(n?.longDescription).toBe("line two\nline three");
  });

  it("gives no notice for a blocked card with an agent working on it", () => {
    const card = { status: "blocked" as const, stalledIn: "todo" as const, blockedReason: "Drafting the ticket…" };
    expect(classifyNotice({ ...card, workingSince: "2026-01-01T00:00:00Z" })).toBeNull();
    expect(classifyNotice({ ...card, workingSince: null })?.title).toBe("Waiting for you");
  });

  it("gives no notice for a failed card with an agent working on it", () => {
    const card = { status: "failed" as const, stalledIn: "in_progress" as const, blockedReason: "Tests failed" };
    expect(classifyNotice({ ...card, workingSince: "2026-01-01T00:00:00Z" })).toBeNull();
  });
});
