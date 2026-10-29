import { describe, expect, it } from "vitest";
import { REQUEST_CAP, requestFromReport } from "./epic";
import { SENTINELS } from "./roster";

const s = SENTINELS[0]!;
const pt = (text: string, ref: string | null = null) => ({ text, ref });

describe("requestFromReport", () => {
  it("names the sentinel and lists the points but not the likes", () => {
    const r = requestFromReport(s, {
      stars: 3,
      summary: "Thin coverage.",
      report: {
        likes: [pt("Nice naming")],
        dislikes: [pt("Slow tests", "a.ts:1")],
        wrong: [pt("Off by one", "b.ts:2")],
        missing: [pt("No e2e")],
      },
    });
    expect(r).toContain(s.who);
    expect(r).toContain(s.name);
    expect(r).toContain("3 of 5");
    expect(r).toContain("Thin coverage.");
    expect(r).toContain("Slow tests (a.ts:1)");
    expect(r).toContain("Off by one (b.ts:2)");
    expect(r).toContain("No e2e");
    expect(r).not.toContain("Nice naming");
  });

  it("opens with the short commit and date, and names the Sentinel without a commit", () => {
    const report = { likes: [], dislikes: [pt("Slow tests")], wrong: [], missing: [] };
    const stamped = requestFromReport(s, { stars: 3, summary: null, report, commitSha: "abc1234def", at: "2026-10-23T10:00:00.000Z" });
    expect(stamped.split("\n")[0]).toBe(`Based on ${s.who}'s audit of abc1234 at 2026-10-23.`);
    const bare = requestFromReport(s, { stars: 3, summary: null, report, commitSha: null, at: null });
    expect(bare.split("\n")[0]).toBe(`Based on ${s.who}'s audit.`);
  });

  it("keeps the commit line within the cap", () => {
    const many = Array.from({ length: 100 }, (_, i) => pt(`point ${i} ${"x".repeat(100)}`));
    const r = requestFromReport(s, {
      stars: 2,
      summary: "s".repeat(5000),
      report: { likes: [], dislikes: many, wrong: many, missing: many },
      commitSha: "abc1234",
      at: "2026-10-23T10:00:00.000Z",
    });
    expect(r.length).toBeLessThanOrEqual(REQUEST_CAP);
    expect(r.startsWith(`Based on ${s.who}'s audit of abc1234`)).toBe(true);
  });

  it("shortens the points to fit the cap", () => {
    const many = Array.from({ length: 100 }, (_, i) => pt(`point ${i} ${"x".repeat(100)}`, "f.ts"));
    const r = requestFromReport(s, {
      stars: 2,
      summary: "s".repeat(5000),
      report: { likes: [], dislikes: many, wrong: many, missing: many },
    });
    expect(r.length).toBeLessThanOrEqual(REQUEST_CAP);
    expect(r).toContain("point 0 ");
  });

  it("puts the rubric checks the audit found unmet first, lowest star first", () => {
    const rubric = {
      context: "c",
      rungs: [2, 3, 4, 5].map((stars) => ({ stars, checks: [{ id: `${stars}a`, text: `Bar ${stars}.`, how: "h" }] })),
    };
    const r = requestFromReport(s, {
      stars: 3,
      summary: null,
      rubric,
      report: {
        likes: [],
        dislikes: [],
        wrong: [pt("Off by one")],
        missing: [],
        checks: [
          { id: "2a", met: true, evidence: "ok" },
          { id: "3a", met: true, evidence: "ok" },
          { id: "4a", met: false, evidence: "No floor in CI." },
          { id: "5a", met: false, evidence: "" },
        ],
      },
    });
    expect(r).toContain("- (4 stars) Bar 4. Found: No floor in CI.\n  Verify: h\n- (5 stars) Bar 5.\n  Verify: h");
    expect(r).not.toContain("Bar 3.");
    expect(r.indexOf("Bar 4.")).toBeLessThan(r.indexOf("Off by one"));
  });

  it("lists every finding under what stands between 4 and 5 stars when capped", () => {
    const rubric = {
      context: "c",
      rungs: [2, 3, 4, 5].map((stars) => ({ stars, checks: [{ id: `${stars}a`, text: `Bar ${stars}.`, how: "h" }] })),
    };
    const checks = [2, 3, 4, 5].map((n) => ({ id: `${n}a`, met: true, evidence: "ok" }));
    const base = { likes: [], dislikes: [pt("Slow")], wrong: [pt("Off")], missing: [pt("Gap")], checks };
    const r = requestFromReport(s, { stars: 4, summary: null, rubric, report: base });
    expect(r).toContain("What stands between 4 and 5 stars:\n- Slow\n- Off\n- Gap");
    const clean = requestFromReport(s, { stars: 4, summary: null, rubric, report: { ...base, dislikes: [], wrong: [], missing: [] } });
    expect(clean).not.toContain("What stands between");
  });

  it("follows an unmet check with its Verify line and asks for it in the acceptance criteria", () => {
    const rubric = { context: "c", rungs: [{ stars: 2, checks: [{ id: "2a", text: "Tests pass.", how: "Run `npm test`: exits 0." }] }] };
    const report = { likes: [], dislikes: [], wrong: [], missing: [], checks: [{ id: "2a", met: false, evidence: "Fails." }] };
    const r = requestFromReport(s, { stars: 1, summary: null, rubric, report });
    expect(r).toContain("- (2 stars) Tests pass. Found: Fails.\n  Verify: Run `npm test`: exits 0.");
    expect(r).toContain("acceptance criteria");
  });

  it("has no Verify lines without rubric checks", () => {
    const r = requestFromReport(s, { stars: 3, summary: null, report: { likes: [], dislikes: [pt("Slow")], wrong: [], missing: [] } });
    expect(r).not.toContain("Verify");
    expect(r).not.toContain("acceptance criteria");
  });
});
