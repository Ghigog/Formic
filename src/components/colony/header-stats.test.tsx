import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColonyProvider } from "./colony";
import {
  ColonyHeaderStats,
  ColonyMobileStats,
  LevelBadge,
} from "./header-stats";
import { SentinelsProvider } from "@/components/sentinels/store";
import { makeCard } from "@/test/cards";
import { scoreOf } from "@/lib/colony/game";
import type { BoardCard } from "@/lib/domain/entities";

/** Merged tickets, one at a time, until the board reaches the level. */
function boardAtLevel(level: number): BoardCard[] {
  const cards: BoardCard[] = [];
  while (scoreOf(cards).level < level) {
    cards.push(makeCard({ status: "merged", mergedAt: "2020-01-01T00:00:00.000Z" }));
  }
  return cards;
}

/** The header's corner with a colony and the sentinels around it. */
function renderHeader(
  ui: ReactNode = <ColonyHeaderStats />,
  cards: BoardCard[] = boardAtLevel(10),
  unlockAll = false,
) {
  return render(
    <ColonyProvider
      storageKey="colony-test-header-stats"
      cards={cards}
      extras={{}}
      unlockAll={unlockAll}
    >
      <SentinelsProvider initial={{}} level={scoreOf(cards).level} unlockAll={unlockAll}>
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

    const badge = screen.getByRole("button", { name: /Audit grade .*Level \d+/ });
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

  it("shows a full bar reading Max level at Lv 99", () => {
    renderHeader(<ColonyHeaderStats />, [makeCard({ status: "merged", mergePoints: 4908 })]);
    const bar = screen.getByRole("progressbar", { name: "Experience to next level" });
    expect(bar).toHaveAttribute("aria-valuenow", bar.getAttribute("aria-valuemax")!);
    expect(screen.getByText("Max level")).toBeInTheDocument();
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

describe("Hidden features", () => {
  const lv1 = () => boardAtLevel(1);

  it("shows only chat and points with heat on a Lv 1 board, on desktop", () => {
    renderHeader(<ColonyHeaderStats />, lv1());
    expect(document.querySelector('[data-colony="score"]')).toBeInTheDocument();
    expect(document.querySelector('[data-colony="heat"]')).toBeInTheDocument();
    expect(document.querySelector('[data-colony="timeline"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /timeline|sentinels/i })).toBeNull();
    expect(document.querySelector('[data-tour="sentinels"]')).toBeNull();
    expect(screen.getByText("LV")).toBeInTheDocument();
  });

  it("shows only points on a Lv 1 board at phone width", () => {
    renderHeader(<ColonyMobileStats />, lv1());
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.querySelector('[data-tour="points"]')).toBeInTheDocument();
    expect(document.querySelector('[data-tour~="sentinels"]')).toBeNull();
    expect(document.querySelector('[data-colony="timeline"]')).toBeNull();
  });

  it("does not open Sentinels from the level badge on a Lv 1 board", async () => {
    renderHeader(<ColonyHeaderStats />, lv1());
    await userEvent.click(screen.getByText("LV"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gates by this board's level: Sentinels at Lv 2, Timeline at Lv 10", () => {
    const { unmount } = renderHeader(<ColonyHeaderStats />, boardAtLevel(2));
    expect(screen.getByRole("button", { name: /Audit grade/ })).toBeInTheDocument();
    expect(document.querySelector('[data-colony="timeline"]')).toBeNull();
    unmount();
    renderHeader(<ColonyHeaderStats />, boardAtLevel(10));
    expect(document.querySelector('[data-colony="timeline"]')).toBeInTheDocument();
  });

  it("shows Sentinels at once on a Lv 1 board with Unlock all on", () => {
    renderHeader(<ColonyHeaderStats />, lv1(), true);
    expect(screen.getByRole("button", { name: /Audit grade/ })).toBeInTheDocument();
    expect(document.querySelector('[data-colony="timeline"]')).toBeNull();
  });
});

describe("ColonyMobileStats", () => {
  it("shows heat and an icon-only timeline button that toggles the timeline", async () => {
    renderHeader(<ColonyMobileStats />);
    // The LV badge is the Audit button; it must not sit inside another button.
    expect(document.querySelector("button button")).toBeNull();
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
      <ColonyProvider storageKey="colony-test-badge" cards={[]} extras={{}} unlockAll>
        <SentinelsProvider initial={{}} level={1} unlockAll>
          <LevelBadge level={level} size={36} />
        </SentinelsProvider>
      </ColonyProvider>
    );
  }
  const flash = () => document.querySelector('[data-audit-face="flash"]');

  it("hides the AUDIT face at rest and reveals it on hover or keyboard focus", () => {
    render(badge(5));
    const face = document.querySelector('[data-audit-face="hover"]')!;
    const classes = face.className.split(" ");

    expect(classes).toContain("invisible");
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("group-hover:visible");
    expect(classes).toContain("group-hover:opacity-100");
    expect(classes).toContain("group-focus-visible:visible");
    expect(classes).toContain("group-focus-visible:opacity-100");
    expect(classes).toContain("transition-[opacity,visibility]");
    expect(classes).toContain("duration-150");
  });

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

describe("Points panel and heat indicator", () => {
  const justMerged = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeCard({
        key: `H-${i}`,
        status: "merged",
        mergedAt: new Date().toISOString(),
      }),
    );
  const panel = () => document.querySelector('[data-colony="points-panel"]')!;
  const filled = () =>
    document.querySelectorAll('[data-colony="heat"] [data-pip="on"]').length;

  it("has no POINTS label, just the number in a panel", () => {
    renderHeader();
    expect(screen.queryByText("POINTS")).toBeNull();
    expect(panel().querySelector('[data-colony="score"]')).not.toBeNull();
    expect(panel().closest('[data-tour="points"]')).not.toBeNull();
  });

  it("fits the score to its digits, with no minimum width", () => {
    renderHeader();
    const score = panel().querySelector('[data-colony="score"]')!;
    expect(score.className).not.toMatch(/min-w/);
  });

  it("is neutral with empty pips and no multiplier at ×1.0", () => {
    renderHeader();
    const heat = document.querySelector('[data-colony="heat"]')!;
    expect(heat).toBeInTheDocument();
    expect(heat.getAttribute("title")).toBeNull();
    expect(heat.querySelectorAll("[data-pip]")).toHaveLength(6);
    expect(filled()).toBe(0);
    expect(panel().getAttribute("style")).toBeNull();
    expect(screen.queryByText(/^×/)).toBeNull();
  });

  it("turns clay at 3 stacks with ×2.5 and the stacks in its tooltip", () => {
    renderHeader(<ColonyHeaderStats />, justMerged(3));
    const heat = document.querySelector('[data-colony="heat"]')!;
    expect(heat).toHaveTextContent("×2.5");
    expect(panel()).toHaveStyle({
      backgroundColor: "var(--clay-chip)",
      color: "var(--clay-chip-text)",
    });
    expect(filled()).toBe(3);
    expect(heat.getAttribute("title")).toMatch(/Stack 3: \d+:\d\d left/);
  });

  it("turns crimson at 5 stacks", () => {
    renderHeader(<ColonyHeaderStats />, justMerged(5));
    expect(panel()).toHaveStyle({ color: "var(--crimson-chip-text)" });
    expect(filled()).toBe(5);
  });

  it("is in the mobile bar too", () => {
    renderHeader(<ColonyMobileStats />, justMerged(1));
    expect(panel()).toHaveStyle({ color: "var(--terracotta-deep)" });
    expect(panel().querySelector('[data-colony="heat"]')).toHaveTextContent(
      "×1.5",
    );
  });
});
