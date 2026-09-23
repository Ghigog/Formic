import { describe, expect, it } from "vitest";
import {
  canUserMove,
  columnFor,
  columnOf,
  isStalled,
  statusForUserDrop,
} from "./status";

describe("columnFor", () => {
  it("maps each running status to its column", () => {
    expect(columnFor("draft")).toBe("backlog");
    expect(columnFor("ready")).toBe("todo");
    expect(columnFor("running")).toBe("in_progress");
    expect(columnFor("review")).toBe("in_review");
    expect(columnFor("merged")).toBe("done");
  });

  it("keeps a stalled card in the column it stalled in", () => {
    expect(columnFor("failed", "in_progress")).toBe("in_progress");
    expect(columnFor("blocked", "in_review")).toBe("in_review");
  });

  it("falls back when a stalled card has no recorded column", () => {
    expect(columnFor("failed", null)).toBe("todo");
  });
});

describe("columnOf", () => {
  it("shows a card where a person put it, even where it cannot work", () => {
    expect(columnOf({ status: "ready", misplacedIn: "in_review" })).toBe("in_review");
  });

  it("otherwise shows it where its status says", () => {
    expect(columnOf({ status: "ready", misplacedIn: null })).toBe("todo");
    expect(columnOf({ status: "failed", stalledIn: "in_progress" })).toBe("in_progress");
  });
});

describe("canUserMove", () => {
  it("allows a single step forward", () => {
    expect(canUserMove("backlog", "todo").ok).toBe(true);
    expect(canUserMove("todo", "in_progress").ok).toBe(true);
  });

  it("refuses to skip a column", () => {
    expect(canUserMove("backlog", "in_progress").ok).toBe(false);
    expect(canUserMove("todo", "done").ok).toBe(false);
  });

  it("allows pulling a card back for recovery", () => {
    expect(canUserMove("in_progress", "todo").ok).toBe(true);
    expect(canUserMove("in_review", "todo").ok).toBe(true);
  });

  it("refuses to move anything out of Done", () => {
    expect(canUserMove("done", "in_review").ok).toBe(false);
  });

  it("treats a same-column reorder as legal", () => {
    expect(canUserMove("todo", "todo").ok).toBe(true);
  });
});

describe("statusForUserDrop", () => {
  it("holds a card in To Do when dependencies are unmet", () => {
    expect(statusForUserDrop("todo", false)).toBe("waiting");
    expect(statusForUserDrop("todo", true)).toBe("ready");
  });
});

describe("isStalled", () => {
  it("covers exactly blocked and failed", () => {
    expect(isStalled("blocked")).toBe(true);
    expect(isStalled("failed")).toBe(true);
    expect(isStalled("running")).toBe(false);
    expect(isStalled("merged")).toBe(false);
  });
});
