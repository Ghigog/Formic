import { describe, expect, it } from "vitest";

import { askedBy, newSince, runningSummary, SUMMARY_CHARS, turnMessage, type ChatLine } from "./transcript";

let t = 0;
const line = (over: Partial<ChatLine> & Pick<ChatLine, "role" | "content">): ChatLine => ({
  id: `m${++t}`,
  status: "done",
  speaker: "assistant",
  createdAt: new Date(1_700_000_000_000 + t * 1000),
  ...over,
});
const person = (content: string) => line({ role: "user", content });
const pm = (content: string, status: ChatLine["status"] = "done") => line({ role: "assistant", content, status });
const notice = (content: string) => line({ role: "assistant", content, kind: "notice" });

describe("what is new to the session", () => {
  it("is everything since the PM's last reply, without its own words", () => {
    const a = person("first");
    const b = pm("answer");
    const c = notice("T-1 added");
    const d = person("second");
    const reply = pm("", "pending");
    expect(newSince([a, b, c, d, reply], reply.id).map((m) => m.content)).toEqual(["T-1 added", "second"]);
  });

  it("keeps two questions queued behind one reply", () => {
    const a = person("one");
    const r1 = pm("", "pending");
    const b = person("two");
    const r2 = pm("", "pending");
    expect(newSince([a, r1, b, r2], r1.id).map((m) => m.content)).toEqual(["one"]);
    // The first reply landed: the second turn carries only what came after it.
    const done = { ...r1, status: "done" as const, content: "ok" };
    expect(newSince([a, done, b, r2], r2.id).map((m) => m.content)).toEqual(["two"]);
  });

  it("names the person's message a reply answers", () => {
    const a = person("why is T-2 red?");
    const reply = pm("", "pending");
    expect(askedBy([a, notice("x"), reply], reply.id)?.content).toBe("why is T-2 red?");
  });
});

describe("the running summary", () => {
  it("names who said each line, one line each, newest last", () => {
    const guest = line({ role: "assistant", content: "Plan looks fine", speaker: "architect", kind: "guest" });
    const summary = runningSummary([person("Add login\nplease"), pm("Done: T-3"), notice("T-3 added"), guest], (s) => `The ${s}`);
    // In the order the chat shows: a notice never splits a question from its replies.
    expect(summary.split("\n")).toEqual(["- Board: T-3 added", "- Person: Add login please", "- PM: Done: T-3", "- The architect: Plan looks fine"]);
  });

  it("stays under its cap, keeping the newest lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => person(`${i} ${"x".repeat(400)}`));
    const summary = runningSummary(many);
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_CHARS);
    expect(summary.split("\n").at(-1)).toMatch(/^- Person: 29 /);
  });

  it("leaves out what is pending or failed", () => {
    expect(runningSummary([person("hi"), pm("", "pending"), pm("boom", "failed")])).toBe("- Person: hi");
  });
});

describe("a turn's message", () => {
  it("is only what is new when the session is resumed", () => {
    const text = turnMessage({ fresh: false, brief: "BRIEF", summary: "SUMMARY", lines: [notice("T-1 failed"), person("look at it")] });
    expect(text).toBe("[Board: T-1 failed]\n\nlook at it");
  });

  it("starts a fresh session with its brief and the summary of the old chat, not a replay", () => {
    const text = turnMessage({ fresh: true, brief: "BRIEF", summary: "- Person: old", lines: [person("new")] });
    expect(text.startsWith("BRIEF")).toBe(true);
    expect(text).toContain("a summary, not a replay");
    expect(text).toContain("- Person: old");
    expect(text.endsWith("new")).toBe(true);
  });

  it("gives guests' words and Formic's own as events, never as the person", () => {
    const guest = line({ role: "assistant", content: "Scope is too wide", speaker: "architect", kind: "guest" });
    const text = turnMessage({ fresh: false, brief: "", summary: "", lines: [guest], wake: "T-4 is blocked", guestName: () => "Architect" });
    expect(text).toBe("[Architect said in the chat: Scope is too wide]\n\n[Formic: T-4 is blocked]");
  });
});
