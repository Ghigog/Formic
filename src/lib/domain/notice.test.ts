import { describe, expect, it } from "vitest";
import { classifyNotice, NO_CHANGES, REVIEW_CEILING, STUCK_RUN } from "./notice";

describe("classifyNotice", () => {
  it("calls a run that hit the usage limit paused, not failed", () => {
    const n = classifyNotice({ status: "failed", stalledIn: "in_progress", blockedReason: "Usage limit reached\nWorks again at 3pm" });
    expect(n).toEqual({
      severity: "paused",
      title: "Paused for usage limit",
      shortDescription: "Usage limit reached",
      longDescription: "Works again at 3pm",
    });
  });

  it("calls a card the start gate held for an agent out of usage paused", () => {
    const n = classifyNotice({ status: "blocked", stalledIn: "todo", blockedReason: "Claude is out of usage until 3pm." });
    expect(n?.severity).toBe("paused");
  });

  it("keeps an ordinary failure a warning", () => {
    expect(classifyNotice({ status: "failed", stalledIn: "todo", blockedReason: "Tests failed" })?.severity).toBe("warning");
  });

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

  it("titles a stuck run 'Stuck' at alert severity, with what each run did as the detail", () => {
    const n = classifyNotice({ status: "blocked", stalledIn: "in_progress", blockedReason: `${STUCK_RUN}\nRun 1 last edited a.ts` });
    expect(n).toEqual({ severity: "alert", title: "Stuck", shortDescription: STUCK_RUN, longDescription: "Run 1 last edited a.ts" });
  });

  it("titles a card stopped at the review ceiling 'Out of reviews'", () => {
    const sub = `${REVIEW_CEILING}: build still failing after 4 reviews of pull request #9`;
    const n = classifyNotice({ status: "blocked", stalledIn: "in_review", blockedReason: `${sub}\nWhat failed:\nx` });
    expect(n).toEqual({ severity: "alert", title: "Out of reviews", shortDescription: sub, longDescription: "What failed:\nx" });
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

describe("classifyNotice for a run that changed nothing", () => {
  it("splits the reason into title, subtitle and description", () => {
    expect(
      classifyNotice({ status: "failed", blockedReason: `${NO_CHANGES}\nNo test added.\nNo test added. T4 is open.\nLog: https://x/1` }),
    ).toEqual({
      severity: "warning",
      title: NO_CHANGES,
      shortDescription: "No test added.",
      longDescription: "No test added. T4 is open.\nLog: https://x/1",
    });
  });

  it("leaves any other failure as it was", () => {
    expect(classifyNotice({ status: "failed", blockedReason: "Boom\nLog: u" })).toMatchObject({
      title: "Failed",
      shortDescription: "Boom",
    });
  });
});
