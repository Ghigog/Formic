import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectKpis } from "@/lib/kpi/compute";
import { SOUND_KEY } from "@/components/colony/store";
import { KpiSection } from "./kpi";

const sfx = vi.fn();
vi.mock("@/components/colony/colony", () => ({ useColony: () => ({ sfx }) }));

const H = 3_600_000;
const D = 24 * H;
const kpis = (window: ProjectKpis["window"], done: number): ProjectKpis => ({
  window,
  tiles: { done, inFlight: 2, cycleTimeDays: 3.5, passRate: 0.75, unchangedAfterSpec: 0.9, costPerPointCents: 120, firstTryRate: 0.8 },
  previous: null,
  records: { bestWeek: null, longestRun: null, fastestTicket: null },
  timeInColumn: {
    backlog: { avgMs: D, totalMs: 3 * D, tickets: 3 },
    todo: null,
    in_progress: { avgMs: 20 * H, totalMs: 40 * H, tickets: 2 },
    in_review: { avgMs: 28 * H, totalMs: 9 * D + 2 * H, tickets: 7 },
  },
  throughput: [{ date: "2026-10-01", done: 2, tickets: [{ id: "t1", key: "T-1", title: "One" }] }, { date: "2026-10-02", done: 1, tickets: [{ id: "t1", key: "T-1", title: "One" }] }],
  cycleTime: [{ doneAt: "2026-10-01T00:00:00Z", days: 2, ticket: { id: "t1", key: "T-1", title: "One" } }, { doneAt: "2026-10-02T00:00:00Z", days: 5, ticket: { id: "t1", key: "T-1", title: "One" } }],
  quality: [{ date: "2026-10-01", passRate: 0.5, unchangedAfterSpec: 1, done: 1, tickets: [{ id: "t1", key: "T-1", title: "One" }] }, { date: "2026-10-02", passRate: 1, unchangedAfterSpec: 0.8, done: 2, tickets: [{ id: "t1", key: "T-1", title: "One" }] }],
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
    render(<KpiSection unlocked />);
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
    render(<KpiSection unlocked />);
    const chart = await screen.findByRole("img", { name: "Average time in column" });
    const heights = [...chart.querySelectorAll("rect[data-column]")].map((r) => [
      r.getAttribute("data-column"),
      Number(r.getAttribute("data-height")),
    ] as const);
    const largest = heights.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(largest[0]).toBe("in_review");
  });

  it("shows a column's exact numbers when hovering or tapping its bar, and Escape closes it", async () => {
    render(<KpiSection unlocked />);
    const chart = await screen.findByRole("img", { name: "Average time in column" });
    const bar = chart.querySelector("rect[data-column=in_review]")!;
    await userEvent.hover(bar);
    expect((await screen.findByRole("tooltip")).textContent).toContain("avg 1d 4h · total 9d 2h");
    expect(screen.getByRole("tooltip").textContent).toContain("7 tickets");
    await userEvent.unhover(bar);
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.click(bar);
    expect(screen.getByRole("tooltip").textContent).toContain("In Review");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.click(bar);
    await userEvent.click(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows a dash and an explanation for a column no ticket has left", async () => {
    render(<KpiSection unlocked />);
    const chart = await screen.findByRole("img", { name: "Average time in column" });
    const dash = chart.querySelector("text[data-column=todo]")!;
    expect(dash.textContent).toBe("–");
    await userEvent.hover(dash);
    expect(screen.getByRole("tooltip").textContent).toContain("No ticket has left To Do in this window");
  });

  it("shows the date and counts for a throughput bar and a quality point", async () => {
    render(<KpiSection unlocked />);
    const thr = await screen.findByRole("img", { name: "Throughput (done per day)" });
    await userEvent.hover(thr.querySelector("rect.fill-clay")!);
    expect(screen.getByRole("tooltip").textContent).toContain("Thu, Oct 1");
    expect(screen.getByRole("tooltip").textContent).toContain("2 tickets done");
    await userEvent.unhover(thr.querySelector("rect.fill-clay")!);
    const q = screen.getByRole("img", { name: "Pass rate and precision over time" });
    await userEvent.hover(q.querySelector("circle[data-tip-mark]")!);
    expect(screen.getByRole("tooltip").textContent).toContain("1 ticket reached Done");
  });

  it("refetches and redraws for all time", async () => {
    render(<KpiSection unlocked />);
    await screen.findByText("3");
    await userEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(await screen.findByText("12")).toBeTruthy();
    expect(fetchMock.mock.calls[1]![0]).toContain("window=all");
  });
});

describe("KpiSection locked", () => {
  it("renders nothing and loads nothing below the KPIs level", () => {
    render(<KpiSection unlocked={false} />);
    expect(screen.queryByRole("region", { name: "KPIs" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("KpiSection reveal", () => {
  let reveal: () => void;
  let frames: Array<(t: number) => void>;
  const runFrame = (t: number) => act(() => frames.splice(0).forEach((f) => f(t)));

  function setup(reduced: boolean) {
    frames = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        done = false;
        constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
          reveal = () => !this.done && cb([{ isIntersecting: true }]);
        }
        observe() {}
        disconnect() {
          this.done = true;
        }
      },
    );
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduced-motion") }));
    vi.stubGlobal("requestAnimationFrame", (f: (t: number) => void) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  }
  beforeEach(() => {
    sfx.mockClear();
    window.localStorage.removeItem(SOUND_KEY);
  });

  it("plays the cue once and animates the count-up when sound is on", async () => {
    setup(false);
    render(<KpiSection unlocked />);
    const done = await screen.findByRole("group", { name: "Done" });
    expect(within(done).getByText("0")).toBeTruthy();
    act(() => reveal());
    act(() => reveal());
    expect(sfx.mock.calls).toEqual([["kpi"]]);
    runFrame(0);
    runFrame(100);
    const mid = within(done).getByText(/^\d$/).textContent;
    expect(mid).not.toBe("3");
    runFrame(900);
    expect(within(done).getByText("3")).toBeTruthy();
  });

  it("stays silent when sound is muted", async () => {
    setup(false);
    window.localStorage.setItem(SOUND_KEY, "off");
    render(<KpiSection unlocked />);
    await screen.findByRole("group", { name: "Done" });
    act(() => reveal());
    expect(sfx).not.toHaveBeenCalled();
  });

  it("shows the values at once under reduced motion", async () => {
    setup(true);
    render(<KpiSection unlocked />);
    const done = await screen.findByRole("group", { name: "Done" });
    act(() => reveal());
    expect(within(done).getByText("3")).toBeTruthy();
    expect(frames).toHaveLength(0);
  });

  describe("at a measured width", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private cb: ResizeObserverCallback) {}
          observe() {
            this.cb([{ contentRect: { width: 280 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
          }
          unobserve() {}
          disconnect() {}
        },
      );
    });

    it("draws each chart 280 wide with text of 10 or more", async () => {
      render(<KpiSection unlocked />);
      await screen.findByRole("group", { name: "Done" });
      const charts = screen.getAllByRole("img");
      expect(charts).toHaveLength(4);
      for (const chart of charts) {
        await waitFor(() => expect(chart.getAttribute("viewBox")).toBe("0 0 280 140"));
        const sizes = [...chart.querySelectorAll("text, g[font-size]")].map((t) =>
          Number((t.closest("[font-size]") ?? t).getAttribute("font-size")),
        );
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) expect(size).toBeGreaterThanOrEqual(10);
      }
    });

    it("puts two-word column labels on two lines", async () => {
      render(<KpiSection unlocked />);
      const chart = await screen.findByRole("img", { name: "Average time in column" });
      const text = [...chart.querySelectorAll("text")].find((t) => t.textContent === "InProgress");
      expect([...text!.querySelectorAll("tspan")].map((t) => t.textContent)).toEqual(["In", "Progress"]);
    });
  });
});
