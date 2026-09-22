import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AmbientDrawer, type AmbientStats } from "./ambient-drawer";

function stats(partial: Partial<AmbientStats> = {}): AmbientStats {
  return {
    activeSandboxes: 0,
    provider: "local",
    tokensIn: 0,
    tokensOut: 0,
    costCents: 0,
    logLines: [],
    ...partial,
  };
}

describe("AmbientDrawer", () => {
  it("says the colony is idle when nothing is running", () => {
    render(<AmbientDrawer stats={stats()} />);
    expect(screen.getAllByText("Colony idle").length).toBeGreaterThan(0);
  });

  it("names the provider and counts the live agents", () => {
    render(<AmbientDrawer stats={stats({ activeSandboxes: 3, provider: "e2b" })} />);
    expect(screen.getByText("3 agents active in E2B")).toBeInTheDocument();
  });

  it("counts one agent without pluralising", () => {
    render(<AmbientDrawer stats={stats({ activeSandboxes: 1, provider: "e2b" })} />);
    expect(screen.getByText("1 agent active in E2B")).toBeInTheDocument();
  });

  it("totals tokens in and out, and reports throughput when a run gives one", () => {
    render(
      <AmbientDrawer
        stats={stats({ tokensIn: 141_200, tokensOut: 41_200, throughput: 1900 })}
      />,
    );
    expect(screen.getByText("182.4k tokens · 1.9k tok/s")).toBeInTheDocument();
  });

  it("says the merge lock is free rather than showing a blank", () => {
    render(<AmbientDrawer stats={stats({ queueDepth: 0 })} />);
    expect(screen.getByText("queue 0 · merge lock free")).toBeInTheDocument();
  });

  it("names the PR holding the merge lock", () => {
    render(<AmbientDrawer stats={stats({ queueDepth: 2, mergeLockPr: 117 })} />);
    expect(
      screen.getByText("queue 2 · merge lock held by PR #117"),
    ).toBeInTheDocument();
  });

  it("opens the terminal on demand and reports an empty stream honestly", async () => {
    const user = userEvent.setup();
    render(<AmbientDrawer stats={stats()} />);

    const toggle = screen.getByRole("button", { name: "Terminal" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("No agents running.")).toBeInTheDocument();
  });

  it("marks stderr apart from stdout in the terminal", async () => {
    const user = userEvent.setup();
    render(
      <AmbientDrawer
        stats={stats({
          logLines: [
            { runId: "run_abc1234", stream: "stdout", line: "cloning" },
            { runId: "run_abc1234", stream: "stderr", line: "fatal: no such ref" },
          ],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByText(/cloning/).className).toContain("text-log-text");
    expect(screen.getByText(/fatal: no such ref/).className).toContain("text-log-error");
  });

  /*
   * The kill switch is not in the artboard. It is here because the ambient
   * bar is the only surface always on screen, and a budget overrun needs one
   * click from anywhere.
   */
  it("offers the kill switch only while something is running", async () => {
    const onStopAll = vi.fn();
    const { rerender } = render(
      <AmbientDrawer stats={stats()} onStopAll={onStopAll} />,
    );
    expect(screen.queryByRole("button", { name: "Stop all" })).toBeNull();

    rerender(
      <AmbientDrawer stats={stats({ activeSandboxes: 2 })} onStopAll={onStopAll} />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop all" }));
    expect(onStopAll).toHaveBeenCalledOnce();
  });
});
