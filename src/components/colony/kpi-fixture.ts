import type { ProjectKpis } from "@/lib/kpi/compute";

export const H = 3_600_000;
export const D = 24 * H;
export const kpis = (
  window: ProjectKpis["window"],
  done: number,
): ProjectKpis => ({
  window,
  tiles: {
    done,
    inFlight: 2,
    cycleTimeDays: 3.5,
    passRate: 0.75,
    unchangedAfterSpec: 0.9,
    costPerPointCents: 120,
    firstTryRate: 0.8,
  },
  previous: null,
  records: { bestWeek: null, longestRun: null, fastestTicket: null },
  timeInColumn: {
    backlog: { avgMs: D, totalMs: 3 * D, tickets: 3 },
    todo: null,
    in_progress: { avgMs: 20 * H, totalMs: 40 * H, tickets: 2 },
    in_review: { avgMs: 28 * H, totalMs: 9 * D + 2 * H, tickets: 7 },
  },
  throughput: [
    {
      date: "2026-10-01",
      done: 2,
      tickets: [{ id: "t1", key: "T-1", title: "One" }],
    },
    {
      date: "2026-10-02",
      done: 1,
      tickets: [{ id: "t1", key: "T-1", title: "One" }],
    },
  ],
  cycleTime: [
    {
      doneAt: "2026-10-01T00:00:00Z",
      days: 2,
      ticket: { id: "t1", key: "T-1", title: "One" },
    },
    {
      doneAt: "2026-10-02T00:00:00Z",
      days: 5,
      ticket: { id: "t1", key: "T-1", title: "One" },
    },
  ],
  quality: [
    {
      date: "2026-10-01",
      passRate: 0.5,
      unchangedAfterSpec: 1,
      done: 1,
      tickets: [{ id: "t1", key: "T-1", title: "One" }],
    },
    {
      date: "2026-10-02",
      passRate: 1,
      unchangedAfterSpec: 0.8,
      done: 2,
      tickets: [{ id: "t1", key: "T-1", title: "One" }],
    },
  ],
});
