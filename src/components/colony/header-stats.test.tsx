import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider } from "./colony";
import { ColonyHeaderStats, ColonyMobileStats, LevelBadge } from "./header-stats";
import { SentinelsProvider } from "@/components/sentinels/store";

/** The header's corner with a colony and the sentinels around it. */
function renderHeader(ui: ReactNode = <ColonyHeaderStats />) {
  return render(
    <ColonyProvider
      storageKey="colony-test-header-stats"
      cards={[]}
      extras={{}}
    >
      <SentinelsProvider initial={{}} level={1}>
        {ui}
      </SentinelsProvider>
    </ColonyProvider>,
  );
}

describe("ColonyHeaderStats", () => {
  it("has one LV badge that is the Audit button, and no separate grade button", async () => {
    renderHeader();

    expect(document.querySelectorAll('[data-colony="level"]')).toHaveLength(1);
    expect(document.querySelector('[data-colony="grade"]')).toBeNull();
    expect(screen.getByText("LV")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open sentinels" }),
    ).not.toBeInTheDocument();

    const badge = screen.getByRole("button", { name: /Audit grade .*Level 1/ });
    expect(badge).toHaveAttribute("data-colony", "level");
    // The hover face is always in the DOM, with the grade letter.
    const face = badge.querySelector('[data-audit-face="hover"]')!;
    expect(face).toHaveTextContent(/^AUDIT[A-F]/);

    await userEvent.click(badge);
    expect(badge).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(badge);
    expect(badge).toHaveAttribute("aria-expanded", "false");
  });

  it("has no mute button", () => {
    renderHeader();
    expect(
      screen.queryByRole("button", { name: /mute sounds/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the level text, XP bar and timeline label with pips on desktop", () => {
    renderHeader();
    expect(screen.getByText(/^Colony · /)).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Experience to next level" }),
    ).toHaveAttribute("aria-valuenow", "0");
    expect(
      screen.getByRole("button", { name: "Open timeline" }),
    ).toHaveTextContent("Timeline");
  });

  it("omits the LV badge and XP bar with showLevel false, keeping points, heat and timeline", () => {
    renderHeader(<ColonyHeaderStats showLevel={false} />);
    expect(screen.queryByText("LV")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(document.querySelector('[data-colony="score"]')).toBeInTheDocument();
    expect(document.querySelector('[data-colony="heat"]')).toBeInTheDocument();
    expect(
      document.querySelector('[data-colony="timeline"]'),
    ).toBeInTheDocument();
  });
});

describe("ColonyMobileStats", () => {
  it("shows heat and an icon-only timeline button that toggles the timeline", async () => {
    renderHeader(<ColonyMobileStats />);
    expect(document.querySelector('[data-colony="heat"]')).toBeInTheDocument();

    const open = screen.getByRole("button", { name: "Open timeline" });
    expect(open).not.toHaveTextContent("Timeline");
    expect(open).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(open);

    const back = screen.getByRole("button", { name: "Back to board" });
    expect(back).toHaveAttribute("aria-expanded", "true");
    expect(back).not.toHaveTextContent("ESC");
    await userEvent.click(back);
    expect(
      screen.getByRole("button", { name: "Open timeline" }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

describe("LevelBadge", () => {
  afterEach(() => vi.useRealTimers());

  function badge(level: number) {
    return (
      <ColonyProvider storageKey="colony-test-badge" cards={[]} extras={{}}>
        <SentinelsProvider initial={{}} level={1}>
          <LevelBadge level={level} size={36} />
        </SentinelsProvider>
      </ColonyProvider>
    );
  }
  const flash = () => document.querySelector('[data-audit-face="flash"]');

  it("flashes the grade 1.5s after a level-up, for 500ms", () => {
    vi.useFakeTimers();
    const { rerender } = render(badge(1));
    rerender(badge(2));
    act(() => void vi.advanceTimersByTime(1499));
    expect(flash()).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(flash()).toHaveTextContent(/^AUDIT[A-F]/);
    act(() => void vi.advanceTimersByTime(500));
    expect(flash()).toBeNull();
  });

  it("never flashes on first render or an unchanged level", () => {
    vi.useFakeTimers();
    const { rerender } = render(badge(3));
    rerender(badge(3));
    act(() => void vi.advanceTimersByTime(5000));
    expect(flash()).toBeNull();
  });

  it("renders a plain non-button badge without Sentinels", () => {
    render(
      <ColonyProvider storageKey="colony-test-badge2" cards={[]} extras={{}}>
        <LevelBadge level={4} size={32} />
      </ColonyProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
});
