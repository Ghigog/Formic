import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { kpis } from "./kpi-fixture";
import {
  KPI_OPEN_TICKET_EVENT,
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
    const heights = [...chart.querySelectorAll("path[data-column]")].map(
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
    const bar = chart.querySelector("path[data-column=in_review]")!;
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
    await userEvent.hover(thr.querySelector("path.fill-clay")!);
    expect(screen.getByRole("tooltip").textContent).toContain("Thu, Oct 1");
    expect(screen.getByRole("tooltip").textContent).toContain("2 tickets done");
    await userEvent.unhover(thr.querySelector("path.fill-clay")!);
    const q = screen.getByRole("img", {
      name: "Pass rate and precision over time",
    });
    await userEvent.hover(q.querySelector("circle[data-tip-mark]")!);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "1 ticket reached Done",
    );
  });

  it("fills each column's bar in its board colour and keeps other charts clay", () => {
    render(<Charts />);
    const col = screen.getByRole("img", { name: "Average time in column" });
    expect(col.querySelector("path[data-column=backlog]")!.getAttribute("class")).toBe("fill-idle");
    expect(col.querySelector("path[data-column=in_progress]")!.getAttribute("class")).toBe("fill-terracotta");
    expect(col.querySelector("path[data-column=in_review]")!.getAttribute("class")).toBe("fill-rust");
    const cyc = screen.getByRole("img", { name: "Cycle time distribution" });
    expect(cyc.querySelector("path")!.getAttribute("class")).toBe("fill-clay");
  });

  it("gives empty throughput days a slot that reads 0", async () => {
    const d = kpis("30d", 3);
    const throughput = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      done: i === 4 ? 3 : 0,
      tickets: i === 4 ? [{ id: "a", key: "T-1", title: "One" }, { id: "b", key: "T-2", title: "Two" }, { id: "c", key: "T-3", title: "Three" }] : [],
    }));
    render(<Throughput data={throughput} />);
    const marks = screen.getAllByRole("button");
    expect(marks).toHaveLength(30);
    await userEvent.hover(marks[0]!);
    expect(screen.getByRole("tooltip").textContent).toContain("0 tickets done");
    expect(d.throughput).toHaveLength(2);
  });

  it("lists the tickets behind a bar; choosing one dispatches the open event; Escape closes", async () => {
    const throughput = [
      { date: "2026-10-01", done: 2, tickets: [{ id: "a", key: "T-1", title: "One" }, { id: "b", key: "T-2", title: "Two" }] },
    ];
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<{ ticketId: string }>).detail.ticketId);
    window.addEventListener(KPI_OPEN_TICKET_EVENT, on);
    render(<Throughput data={throughput} />);
    const bar = screen.getByRole("button", { name: /Oct 1/ });
    bar.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /T-1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /T-2/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /T-2/ }));
    expect(seen).toEqual(["b"]);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: /T-1/ })).toBeNull();
    window.removeEventListener(KPI_OPEN_TICKET_EVENT, on);
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
