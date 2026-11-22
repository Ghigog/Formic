import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ repository: () => ({}) }));

const { mentionedKeys, resolveMentions } = await import("./context");

const cards = (...keys: string[]) => keys.map((key) => ({ key }));

describe("resolveMentions", () => {
  it("treats a bare T1 as every card ending in T1, and returns it as ambiguous", () => {
    const r = resolveMentions("Is T1 stalled?", cards("EPIC-122-T1", "T-1", "EPIC-119-T4"));
    expect(r.keys).toEqual([]);
    expect(r.ambiguous).toEqual([{ text: "T1", candidates: ["EPIC-122-T1", "T-1"] }]);
  });

  it("reads a bare suffix that fits one card as that card", () => {
    expect(resolveMentions("how is t 4?", cards("EPIC-119-T4", "T-1"))).toEqual({ keys: ["EPIC-119-T4"], ambiguous: [] });
  });

  it("does not call a full Epic ticket key ambiguous", () => {
    const r = resolveMentions("Is EPIC-122-T1 stalled?", cards("EPIC-122-T1", "T-1"));
    expect(r).toEqual({ keys: ["EPIC-122-T1"], ambiguous: [] });
  });

  it("reads a written T-1 as that card, not as a bare suffix", () => {
    const r = resolveMentions("Is T-1 stalled?", cards("EPIC-122-T1", "T-1"));
    expect(r).toEqual({ keys: ["T-1"], ambiguous: [] });
  });

  it("names nothing when no card is mentioned", () => {
    expect(resolveMentions("Is it stalled?", cards("EPIC-122-T1", "T-1"))).toEqual({ keys: [], ambiguous: [] });
  });

  it("leaves mentionedKeys as it was", () => {
    expect(mentionedKeys("t94", cards("T-94"))).toEqual(["T-94"]);
  });
});
