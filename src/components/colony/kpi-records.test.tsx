import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { KpiRecords } from "./kpi-records";

const sfx = vi.fn();
vi.mock("@/components/colony/colony", () => ({
  useColony: () => ({ sfx, storageKey: "formic:colony:o/r" }),
}));

const old = "2025-01-01T00:00:00Z";
const records = (count: number, at = old) => ({
  bestWeek: { count, weekStart: "2025-01-01", achievedAt: at },
  longestRun: null,
  fastestTicket: {
    ticket: { id: "t", key: "T-1", title: "One" },
    days: 0.5,
    doneAt: at,
  },
  heaviestTicket: null,
});
const animate = vi.fn();
beforeEach(() => {
  window.localStorage.clear();
  sfx.mockClear();
  animate.mockClear();
  HTMLElement.prototype.animate = animate;
});
afterEach(cleanup);

describe("KpiRecords", () => {
  it("stores old records silently when nothing is stored", () => {
    render(<KpiRecords records={records(4)} settled />);
    expect(animate).not.toHaveBeenCalled();
    expect(sfx).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("formic:colony:o/r:kpi-records")).toBe(
      '{"bestWeek":4,"fastestTicket":0.5}',
    );
  });

  it("stamps only the record that beats the stored one, and waits for settled", () => {
    window.localStorage.setItem(
      "formic:colony:o/r:kpi-records",
      '{"bestWeek":4,"fastestTicket":0.5}',
    );
    const { rerender } = render(
      <KpiRecords records={records(6)} settled={false} />,
    );
    expect(animate).not.toHaveBeenCalled();
    rerender(<KpiRecords records={records(6)} settled />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(sfx).toHaveBeenCalledWith("stamp");
  });

  it("shows no badges without records", () => {
    render(
      <KpiRecords
        records={{ bestWeek: null, longestRun: null, fastestTicket: null, heaviestTicket: null }}
        settled
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
  });
});
