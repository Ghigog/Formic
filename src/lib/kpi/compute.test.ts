import { describe, expect, it } from "vitest";
import type { TicketColumnEntry } from "@/lib/db/repository";
import { passRate, precision, projectKpis, timeline } from "./compute";

const e = (column: TicketColumnEntry["column"], enteredAt: string, exitedAt: string | null, synthetic = false): TicketColumnEntry => ({
  column, enteredAt, exitedAt, synthetic,
});
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
    const k = projectKpis([{ entries: history, changes: [] }], "30d", now);
    expect(k.tiles).toMatchObject({ done: 1, inFlight: 0, cycleTimeDays: 5, passRate: 0.5, precision: 1 });
    expect(k.throughput).toEqual([{ date: "2026-10-07", done: 1 }]);
    expect(k.quality).toEqual([{ date: "2026-10-07", passRate: 0.5, precision: 1 }]);
    expect(k.timeInColumn.in_progress).toBe(1.5);
  });

  it("the 30d window drops older work", () => {
    expect(projectKpis([{ entries: history, changes: [] }], "30d", new Date("2027-01-01T00:00:00Z")).tiles.done).toBe(0);
    expect(projectKpis([{ entries: history, changes: [] }], "all", new Date("2027-01-01T00:00:00Z")).tiles.done).toBe(1);
  });
});
