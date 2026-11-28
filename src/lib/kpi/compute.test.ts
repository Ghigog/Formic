import { describe, expect, it } from "vitest";
import type { TicketColumnEntry } from "@/lib/db/repository";
import type { TokenWork } from "./tokens";
import { passRate, precision, projectKpis, timeline, type TicketHistory } from "./compute";
import { changesText, CHANGES_AFTER_SPEC_LABEL } from "./labels";

const e = (column: TicketColumnEntry["column"], enteredAt: string, exitedAt: string | null, synthetic = false): TicketColumnEntry => ({
  column, enteredAt, exitedAt, synthetic,
});
const h = (entries: TicketColumnEntry[], over: Partial<TicketHistory["ticket"]> = {}, changes: TicketHistory["changes"] = []): TicketHistory => ({
  ticket: { id: "t", key: "T-1", title: "One", storyPoints: null, costCents: 0, attempts: 0, ...over },
  entries,
  changes,
  work: [],
});
const doneAt = (iso: string) => [e("in_progress", iso, iso), e("done", iso, null)];
const now = new Date("2026-10-10T00:00:00Z");
const history: TicketColumnEntry[] = [
  e("backlog", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
  e("in_progress", "2026-10-02T00:00:00Z", "2026-10-04T00:00:00Z"),
  e("in_review", "2026-10-04T00:00:00Z", "2026-10-05T00:00:00Z"),
  e("in_progress", "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"),
  e("in_review", "2026-10-06T00:00:00Z", "2026-10-07T00:00:00Z"),
  e("done", "2026-10-07T00:00:00Z", null),
];

describe("kpi compute", () => {
  it("gives each entry a duration, none for synthetic ones", () => {
    const t = timeline([history[1]!, e("backlog", "2026-10-01T00:00:00Z", null, true)], now);
    expect(t[0]!.durationMs).toBe(2 * 86_400_000);
    expect(t[1]!.durationMs).toBeNull();
  });

  it("pass rate counts reviews that moved on", () => {
    expect(passRate(history)).toBe(0.5);
    expect(passRate([history[0]!])).toBeNull();
  });

  it("precision is clean when nothing changed", () => {
    expect(precision([])).toEqual({ changes: 0, precise: true });
    expect(precision([{ kind: "points", at: "x", detail: null }]).precise).toBe(false);
  });

  it("builds tiles, throughput and cycle time", () => {
    const k = projectKpis([h(history)], "30d", now);
    expect(k.tiles).toMatchObject({ done: 1, inFlight: 0, cycleTimeDays: 5, passRate: 0.5, unchangedAfterSpec: 1 });
    expect(k.throughput.at(-4)).toEqual({ date: "2026-10-07", done: 1, tickets: [{ id: "t", key: "T-1", title: "One" }] });
    expect(k.quality).toEqual([{ date: "2026-10-07", passRate: 0.5, unchangedAfterSpec: 1, done: 1, tickets: [{ id: "t", key: "T-1", title: "One" }] }]);
    expect(k.timeInColumn.in_progress).toEqual({ avgMs: 3 * 86_400_000, totalMs: 3 * 86_400_000, tickets: 1 });
  });

  it("the 30d window drops older work", () => {
    expect(projectKpis([h(history)], "30d", new Date("2027-01-01T00:00:00Z")).tiles.done).toBe(0);
    expect(projectKpis([h(history)], "all", new Date("2027-01-01T00:00:00Z")).tiles.done).toBe(1);
  });

  const D = 86_400_000;
  it("sums a ticket's review stays across a send-back and gives Done no time", () => {
    const k = projectKpis([h(history)], "30d", now);
    expect(k.timeInColumn.in_review).toEqual({ avgMs: 2 * D, totalMs: 2 * D, tickets: 1 });
    expect(k.timeInColumn).not.toHaveProperty("done");
  });

  it("leaves open stays out of time in column", () => {
    const parked = [e("backlog", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"), e("in_progress", "2026-10-02T00:00:00Z", null)];
    const k = projectKpis([h(parked)], "30d", now);
    expect(k.timeInColumn.in_progress).toBeNull();
    expect(k.timeInColumn.backlog?.tickets).toBe(1);
  });

  it("keeps synthetic Done out of throughput, cycle time and the 30-day tile, but not All time", () => {
    const old = [e("done", "2026-10-09T00:00:00Z", null, true)];
    const real = [e("in_progress", "2026-10-08T00:00:00Z", "2026-10-09T00:00:00Z"), e("done", "2026-10-09T00:00:00Z", null)];
    const hs = [h(old), h(real)];
    const k = projectKpis(hs, "30d", now);
    expect(k.tiles.done).toBe(1);
    expect(k.throughput.filter((d) => d.done)).toHaveLength(1);
    expect(k.cycleTime).toHaveLength(1);
    expect(k.quality).toHaveLength(1);
    const all = projectKpis(hs, "all", now);
    expect(all.tiles.done).toBe(2);
    expect(all.throughput).toEqual([{ date: "2026-10-09", done: 1, tickets: [expect.any(Object)] }, { date: "2026-10-10", done: 0, tickets: [] }]);
  });

  it("counts a ticket toward precision only when a real stay entered in the window", () => {
    const stale = [e("in_progress", "2026-01-01T00:00:00Z", null)];
    const k = projectKpis([h(stale, {}, [{ kind: "points", at: "x", detail: null }])], "30d", now);
    expect(k.tiles.unchangedAfterSpec).toBeNull();
  });

  it("gives every day of the window a throughput slot, empty ones with nothing", () => {
    const hs = ["2026-10-01", "2026-10-05", "2026-10-09"].map((d, i) => h(doneAt(`${d}T10:00:00Z`), { id: `t${i}` }));
    const k = projectKpis(hs, "30d", now);
    expect(k.throughput).toHaveLength(30);
    expect(k.throughput[0]!.date).toBe("2026-09-11");
    expect(k.throughput.at(-1)!.date).toBe("2026-10-10");
    const empty = k.throughput.filter((d) => d.done === 0);
    expect(empty).toHaveLength(27);
    expect(empty.every((d) => d.tickets.length === 0)).toBe(true);
    expect(projectKpis(hs, "all", now).throughput).toHaveLength(10);
  });

  it("measures unchanged after spec as a share and words the changes", () => {
    const change = { kind: "points" as const, at: "x", detail: null };
    const k = projectKpis([h(doneAt("2026-10-05T00:00:00Z"), { id: "a" }, [change, change]), h(doneAt("2026-10-06T00:00:00Z"), { id: "b" })], "30d", now);
    expect(k.tiles.unchangedAfterSpec).toBe(0.5);
    expect(changesText(0)).toBe("No changes");
    expect(changesText(1)).toBe("1 change");
    expect(changesText(2)).toBe("2 changes");
    expect(CHANGES_AFTER_SPEC_LABEL).toBe("Changes after spec");
  });

  it("works out cost per point and first-try rate", () => {
    const k = projectKpis(
      [h(doneAt("2026-10-05T00:00:00Z"), { id: "a", storyPoints: 3, costCents: 300 }), h(doneAt("2026-10-06T00:00:00Z"), { id: "b", storyPoints: 5, costCents: 500, attempts: 2 })],
      "30d",
      now,
    );
    expect(k.tiles.costPerPointCents).toBe(100);
    expect(k.tiles.firstTryRate).toBe(0.5);
    expect(projectKpis([], "30d", now).tiles).toMatchObject({ costPerPointCents: null, firstTryRate: null });
  });

  it("compares with the 30 days before, and records over all time", () => {
    const hs = [
      ...["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-09"].map((d, i) => h(doneAt(`${d}T00:00:00Z`), { id: `n${i}` })),
      ...["2026-08-20", "2026-08-25"].map((d, i) => h(doneAt(`${d}T00:00:00Z`), { id: `o${i}` })),
    ];
    const k = projectKpis(hs, "30d", now);
    expect(k.tiles.done).toBe(4);
    expect(k.previous?.done).toBe(2);
    expect(projectKpis(hs, "all", now).previous).toBeNull();
    // Weeks start on Monday: 2026-09-28 holds Oct 1-3.
    expect(k.records.bestWeek).toEqual({ count: 3, weekStart: "2026-09-28", achievedAt: "2026-10-03T00:00:00Z" });
    expect(k.records.longestRun).toEqual({ days: 3, endsOn: "2026-10-03" });
    expect(k.records.fastestTicket?.days).toBe(0);
    expect(projectKpis([], "30d", now).records).toEqual({ bestWeek: null, longestRun: null, fastestTicket: null, heaviestTicket: null });
  });

  describe("tokens", () => {
    const w = (at: string, tokens: number): TokenWork => ({ at, tokensIn: tokens / 2, tokensOut: tokens / 2, reported: true });
    const withWork = (iso: string, work: TokenWork[], over: Partial<TicketHistory["ticket"]>): TicketHistory => ({
      ...h([e("in_progress", iso, iso), e("done", iso, null)], over),
      work,
    });
    const hs = () => [
      withWork("2026-09-30T00:00:00Z", [w("2026-09-29T00:00:00Z", 90_000)], { id: "a", storyPoints: 3 }),
      withWork("2026-08-31T00:00:00Z", [w("2026-08-30T00:00:00Z", 10_000)], { id: "b", storyPoints: 2 }),
    ];

    it("reads the 30d window with the one before it, and All time", () => {
      const k = projectKpis(hs(), "30d", now);
      expect(k.tiles.tokensUsed).toBe(90_000);
      expect(k.tiles.tokensPerPoint).toBe(30_000);
      expect(k.previous?.tokensPerPoint).toBe(5_000);
      expect(k.previous?.tokensUsed).toBe(10_000);
      const all = projectKpis(hs(), "all", now);
      expect(all.tiles.tokensPerPoint).toBe(20_000);
      expect(all.records.heaviestTicket).toMatchObject({ ticket: { id: "a" }, tokens: 90_000, doneAt: "2026-09-30T00:00:00Z" });
      expect(projectKpis([], "30d", now).tiles).toMatchObject({ tokensUsed: 0, tokensPerPoint: null });
    });

    it("counts Epic work in tokens used only", () => {
      const k = projectKpis(hs(), "30d", now, [w("2026-10-01T00:00:00Z", 5_000), w("2026-01-01T00:00:00Z", 7_000)]);
      expect(k.tiles.tokensUsed).toBe(95_000);
      expect(k.tiles.tokensPerPoint).toBe(30_000);
    });

    it("adds a ticket's stays in a column once", () => {
      const entries = [
        e("in_progress", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
        e("in_review", "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"),
        e("in_progress", "2026-10-03T00:00:00Z", "2026-10-04T00:00:00Z"),
        e("done", "2026-10-04T00:00:00Z", null),
      ];
      const t: TicketHistory = { ...h(entries), work: [w("2026-10-01T01:00:00Z", 120_000), w("2026-10-03T01:00:00Z", 30_000), w("2026-10-02T01:00:00Z", 8_000)] };
      const k = projectKpis([t], "30d", now);
      expect(k.tokensInColumn.in_progress).toEqual({ avgTokens: 150_000, totalTokens: 150_000, tickets: 1 });
      expect(k.tokensInColumn.in_review?.avgTokens).toBe(8_000);
      expect(k.tokensInColumn.backlog).toBeNull();
      expect(k.tokensPerDone).toEqual([{ date: "2026-10-04", tokens: 158_000, done: 1, tickets: [{ id: "t", key: "T-1", title: "One" }] }]);
    });
  });
});
