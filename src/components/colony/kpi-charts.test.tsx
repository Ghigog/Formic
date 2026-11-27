import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { kpis } from "./kpi-fixture";
import {
  CycleTime,
  QualityChart,
  Throughput,
  TimeInColumn,
} from "./kpi-charts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Charts() {
  const d = kpis("30d", 3);
  return (
    <>
      <TimeInColumn data={d.timeInColumn} />
      <QualityChart data={d.quality} />
      <Throughput data={d.throughput} />
      <CycleTime data={d.cycleTime} />
    </>
  );
}

describe("KPI charts", () => {
  it("draws the highest-average column as the largest bar", async () => {
    render(<Charts />);
    const chart = screen.getByRole("img", { name: "Average time in column" });
    const heights = [...chart.querySelectorAll("rect[data-column]")].map(
      (r) =>
        [
          r.getAttribute("data-column"),
          Number(r.getAttribute("data-height")),
        ] as const,
    );
    const largest = heights.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(largest[0]).toBe("in_review");
  });

  it("shows a column's exact numbers when hovering or tapping its bar, and Escape closes it", async () => {
    render(<Charts />);
    const chart = screen.getByRole("img", { name: "Average time in column" });
    const bar = chart.querySelector("rect[data-column=in_review]")!;
    await userEvent.hover(bar);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "avg 1d 4h · total 9d 2h",
    );
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
    render(<Charts />);
    const chart = screen.getByRole("img", { name: "Average time in column" });
    const dash = chart.querySelector("text[data-column=todo]")!;
    expect(dash.textContent).toBe("–");
    await userEvent.hover(dash);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "No ticket has left To Do in this window",
    );
  });

  it("shows the date and counts for a throughput bar and a quality point", async () => {
    render(<Charts />);
    const thr = screen.getByRole("img", { name: "Throughput (done per day)" });
    await userEvent.hover(thr.querySelector("rect.fill-clay")!);
    expect(screen.getByRole("tooltip").textContent).toContain("Thu, Oct 1");
    expect(screen.getByRole("tooltip").textContent).toContain("2 tickets done");
    await userEvent.unhover(thr.querySelector("rect.fill-clay")!);
    const q = screen.getByRole("img", {
      name: "Pass rate and precision over time",
    });
    await userEvent.hover(q.querySelector("circle[data-tip-mark]")!);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "1 ticket reached Done",
    );
  });

  describe("at a measured width", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private cb: ResizeObserverCallback) {}
          observe() {
            this.cb(
              [{ contentRect: { width: 280 } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            );
          }
          unobserve() {}
          disconnect() {}
        },
      );
    });

    it("draws each chart 280 wide with text of 10 or more", async () => {
      render(<Charts />);
      const charts = screen.getAllByRole("img");
      expect(charts).toHaveLength(4);
      for (const chart of charts) {
        await waitFor(() =>
          expect(chart.getAttribute("viewBox")).toBe("0 0 280 140"),
        );
        const sizes = [...chart.querySelectorAll("text, g[font-size]")].map(
          (t) =>
            Number((t.closest("[font-size]") ?? t).getAttribute("font-size")),
        );
        expect(sizes.length).toBeGreaterThan(0);
        for (const size of sizes) expect(size).toBeGreaterThanOrEqual(10);
      }
    });

    it("puts two-word column labels on two lines", async () => {
      render(<Charts />);
      const chart = screen.getByRole("img", { name: "Average time in column" });
      const text = [...chart.querySelectorAll("text")].find(
        (t) => t.textContent === "InProgress",
      );
      expect(
        [...text!.querySelectorAll("tspan")].map((t) => t.textContent),
      ).toEqual(["In", "Progress"]);
    });
  });
});
