import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SOUND_KEY } from "@/components/colony/store";
import { KpiSection } from "./kpi";
import { kpis } from "./kpi-fixture";

const sfx = vi.fn();
vi.mock("@/components/colony/colony", () => ({ useColony: () => ({ sfx }) }));

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
});
