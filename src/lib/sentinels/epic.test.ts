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
});
