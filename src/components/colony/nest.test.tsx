import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { XP_PER_LEVEL, levelOf, rankOf, type Score } from "@/lib/colony/game";
import { ColonyPopover } from "./nest";
import type { ColonyApi } from "./colony";

let api: ColonyApi | null = null;
vi.mock("./colony", () => ({ useColony: () => api }));

beforeAll(() => {
  // jsdom has no Web Animations; the popover animates its entrance.
  HTMLElement.prototype.animate = vi.fn();
});

function scoreAt(earned: number): Score {
  const level = levelOf(earned);
  return { earned, points: earned, level, rank: rankOf(level), intoLevel: earned % XP_PER_LEVEL, bugs: 0, squashed: 0 };
}

function openPopoverAt(earned: number) {
  api = {
    score: scoreAt(earned),
    colonyOpen: true,
    setColonyOpen: vi.fn(),
    shape: "dot",
    color: "clay",
    bugHex: "#000",
    tryStyle: vi.fn(),
    fx: { reducedMotion: true },
  } as unknown as ColonyApi;
  render(<ColonyPopover />);
  const bar = screen.getByText(/Every style unlocked|unlocks/).nextElementSibling!.firstElementChild as HTMLElement;
  return bar.style.width;
}

describe("ColonyPopover progress bar", () => {
  it("is full once every style is unlocked, and the header keeps the level XP", () => {
    expect(openPopoverAt(8 * XP_PER_LEVEL + 20)).toBe("100%");
    expect(screen.getByText("Every style unlocked")).toBeTruthy();
    expect(screen.getByText(/420 XP earned · 20\/50 this level/)).toBeTruthy();
  });

  it("shows progress into the level before the last unlock", () => {
    expect(openPopoverAt(2 * XP_PER_LEVEL + 10)).toBe("20%");
    expect(screen.getByText(/unlocks/)).toBeTruthy();
  });
});
