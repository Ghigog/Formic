import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PlaytestApi } from "./playtest-context";

const { colony, playtest } = vi.hoisted(() => ({
  colony: { current: null as null | { featureUnlocked: (k: string) => boolean; revealing: string | null; sound: unknown; settleReveal: () => void } },
  playtest: { current: null as Partial<PlaytestApi> | null },
}));

vi.mock("@/components/colony/colony", () => ({ useColony: () => colony.current }));
vi.mock("@/components/colony/feature-reveal", () => ({ FeatureReveal: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./playtest-context", () => ({ usePlaytest: () => playtest.current }));

const { PlaytestButton } = await import("./playtest-button");

function setup(level: { unlocked: boolean; revealing?: string | null }, api: Partial<PlaytestApi>) {
  colony.current = { featureUnlocked: () => level.unlocked, revealing: level.revealing ?? null, sound: {}, settleReveal: () => {} };
  playtest.current = { open: vi.fn(), session: null, ...api };
  return render(<PlaytestButton />);
}

afterEach(cleanup);

describe("PlaytestButton", () => {
  it("is not there below its level", () => {
    const { container } = setup({ unlocked: false }, { access: { ok: true } });
    expect(container.innerHTML).toBe("");
  });

  it("shows while its unlock is being revealed", () => {
    setup({ unlocked: false, revealing: "playtest" }, { access: { ok: true } });
    expect(screen.getByRole("button", { name: /Playtest/ })).toBeTruthy();
  });

  it("opens the screen when the person can use it", () => {
    setup({ unlocked: true }, { access: { ok: true } });
    fireEvent.click(screen.getByRole("button", { name: /Playtest/ }));
    expect(playtest.current!.open).toHaveBeenCalled();
  });

  it("is grayed with no E2B key, and points to Settings", () => {
    setup(
      { unlocked: true },
      { access: { ok: false, reason: "no-key", message: "Playtest runs in an E2B sandbox on your own key. Add it in Settings." } },
    );
    const button = screen.getByRole("button", { name: /Playtest/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("data-tour")).toBe("playtest playtest-key");
    fireEvent.click(button);
    expect(playtest.current!.open).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("on your own key");
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toBe("/settings#sandbox");
  });

  it("says why when nothing has merged, with no Settings link", () => {
    setup({ unlocked: true }, { access: { ok: false, reason: "nothing-merged", message: "Nothing shipped yet." } });
    fireEvent.click(screen.getByRole("button", { name: /Playtest/ }));
    expect(screen.getByRole("dialog").textContent).toContain("Nothing shipped yet.");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows a running session's time left", () => {
    const endsAt = new Date(Date.now() + 12 * 60_000 + 5000).toISOString();
    setup({ unlocked: true }, { access: { ok: true }, session: { status: "live", endsAt } as PlaytestApi["session"] });
    expect(screen.getByRole("button", { name: /Playtest/ }).textContent).toMatch(/12:0\d left/);
  });
});
