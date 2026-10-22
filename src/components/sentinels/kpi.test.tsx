import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectKpis } from "@/lib/kpi/compute";
import { KpiSection } from "./kpi";

const kpis = (window: ProjectKpis["window"], done: number): ProjectKpis => ({
  window,
  tiles: { done, inFlight: 2, cycleTimeDays: 3.5, passRate: 0.75, precision: 0.9 },
  timeInColumn: { backlog: 1, todo: 0.5, in_progress: 2, in_review: 4, done: null },
  throughput: [{ date: "2026-10-01", done: 2 }, { date: "2026-10-02", done: 1 }],
  cycleTime: [{ doneAt: "2026-10-01T00:00:00Z", days: 2 }, { doneAt: "2026-10-02T00:00:00Z", days: 5 }],
  quality: [{ date: "2026-10-01", passRate: 0.5, precision: 1 }, { date: "2026-10-02", passRate: 1, precision: 0.8 }],
});

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (url: string) =>
    Response.json(url.includes("window=all") ? kpis("all", 12) : kpis("30d", 3)),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KpiSection", () => {
  it("shows the tiles and four charts", async () => {
    render(<KpiSection />);
    const done = await screen.findByRole("group", { name: "Done" });
    expect(within(done).getByText("3")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Pass rate" })).getByText("75%")).toBeTruthy();
    for (const name of [
      "Average time in column",
      "Pass rate and precision over time",
      "Throughput (done per day)",
      "Cycle time distribution",
    ])
      expect(screen.getByRole("img", { name })).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toContain("window=30d");
  });

  it("draws the highest-average column as the largest bar", async () => {
    render(<KpiSection />);
    const chart = await screen.findByRole("img", { name: "Average time in column" });
    const heights = [...chart.querySelectorAll("rect[data-column]")].map((r) => [
      r.getAttribute("data-column"),
      Number(r.getAttribute("data-height")),
    ] as const);
    const largest = heights.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(largest[0]).toBe("in_review");
  });

  it("refetches and redraws for all time", async () => {
    render(<KpiSection />);
    await screen.findByText("3");
    await userEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(await screen.findByText("12")).toBeTruthy();
    expect(fetchMock.mock.calls[1]![0]).toContain("window=all");
  });
});
