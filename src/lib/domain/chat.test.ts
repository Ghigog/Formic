import { describe, expect, it } from "vitest";

import { kindOf, noticeEvent, threadOrder } from "./chat";

type M = { id: string; role: "user" | "assistant"; speaker?: string; kind?: string; createdAt?: string };

const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 12, 0, s)).toISOString();
const person = (id: string, s = 0): M => ({ id, role: "user", createdAt: at(s) });
const pm = (id: string, s = 0): M => ({ id, role: "assistant", speaker: "assistant", createdAt: at(s) });
const guest = (id: string, s = 0): M => ({ id, role: "assistant", speaker: "reviewer", createdAt: at(s) });
const notice = (id: string, s = 0): M => ({ id, role: "assistant", kind: "notice", createdAt: at(s) });
const ids = (ms: M[]) => threadOrder(ms).map((m) => m.id);

describe("kindOf", () => {
  it("keeps a stored kind and works out one for an older message", () => {
    expect(kindOf({ role: "assistant", kind: "notice" })).toBe("notice");
    expect(kindOf({ role: "user" })).toBe("person");
    expect(kindOf({ role: "assistant", speaker: "assistant" })).toBe("pm");
    expect(kindOf({ role: "assistant", speaker: "sentinel:qa" })).toBe("guest");
    expect(kindOf({ role: "assistant", kind: "nonsense" })).toBe("pm");
  });
});

describe("noticeEvent", () => {
  it("frames a notice as the board's event", () => {
    expect(noticeEvent(" EPIC-122-T3 added \n")).toBe("[Board: EPIC-122-T3 added]");
  });
});

describe("threadOrder", () => {
  it("keeps the written order when nothing splits a question from its answer", () => {
    expect(ids([notice("n0"), person("q"), pm("r"), notice("n1")])).toEqual(["n0", "q", "r", "n1"]);
  });

  it("moves a notice that landed between a question and its reply above the question", () => {
    expect(ids([person("q"), notice("n"), pm("r", 1)])).toEqual(["n", "q", "r"]);
  });

  it("keeps every queued reply under its question, with notices between them moved up", () => {
    expect(ids([person("q"), pm("r1"), notice("n"), guest("r2", 2)])).toEqual(["n", "q", "r1", "r2"]);
  });

  it("leaves a notice after the last reply where it is", () => {
    expect(ids([person("q1"), pm("r1"), notice("n"), person("q2", 5), pm("r2", 5)])).toEqual(["q1", "r1", "n", "q2", "r2"]);
  });

  it("leaves a reply Formic started later on its own after the notice that woke it", () => {
    expect(ids([person("q"), pm("r"), notice("n", 120), pm("woken", 121)])).toEqual(["q", "r", "n", "woken"]);
  });

  it("keeps notices with no question before them in place", () => {
    expect(ids([notice("n1"), notice("n2"), pm("r")])).toEqual(["n1", "n2", "r"]);
  });
});
