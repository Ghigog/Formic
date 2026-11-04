import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

const cues = vi.hoisted(() => [] as string[]);
const hear = vi.hoisted(() => ({ ready: true, waiting: [] as Array<() => void> }));
vi.mock("./colony", () => ({
  useColony: () => ({ sfx: (n: string) => cues.push(n) }),
}));
vi.mock("@/components/onboarding/voice", () => ({
  whenHeard: (f: () => void) => (hear.ready ? f() : hear.waiting.push(f)),
}));

import { FeatureReveal, FADE_MS, RISE_MS, SPACE_MS } from "./feature-reveal";

const phase = () => screen.getByRole("button").closest("[data-phase]")?.getAttribute("data-phase");

function mount(reduced = false, onSettled = vi.fn()) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce"), media: q }));
  render(
    <FeatureReveal reveal onSettled={onSettled}>
      <button>Timeline</button>
    </FeatureReveal>,
  );
  return onSettled;
}

beforeEach(() => {
  vi.useFakeTimers();
  cues.length = 0;
  hear.ready = true;
  hear.waiting = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FeatureReveal", () => {
  it("clears a space, then rises, plays the cue once and settles once", () => {
    const settled = mount();
    expect(phase()).toBe("space");
    expect(cues).toEqual([]);
    act(() => void vi.advanceTimersByTime(SPACE_MS));
    expect(phase()).toBe("rise");
    expect(cues).toEqual(["celebrate"]);
    expect(settled).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(RISE_MS));
    expect(phase()).toBe("settled");
    expect(settled).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(2000));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(cues).toEqual(["celebrate"]);
  });

  it("under reduced motion skips the space, fades in, and still plays the cue", () => {
    const settled = mount(true);
    act(() => void vi.advanceTimersByTime(16));
    expect(phase()).toBe("rise");
    expect(cues).toEqual(["celebrate"]);
    act(() => void vi.advanceTimersByTime(FADE_MS));
    expect(phase()).toBe("settled");
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("holds the cue until the page can be heard, but the visual plays", () => {
    hear.ready = false;
    const settled = mount();
    act(() => void vi.advanceTimersByTime(SPACE_MS + RISE_MS));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(cues).toEqual([]);
    act(() => hear.waiting.forEach((f) => f()));
    expect(cues).toEqual(["celebrate"]);
  });

  it("without reveal is just the button: no animation, no cue", () => {
    render(
      <FeatureReveal reveal={false}>
        <button>Timeline</button>
      </FeatureReveal>,
    );
    act(() => void vi.advanceTimersByTime(2000));
    expect(cues).toEqual([]);
    expect(screen.getByRole("button").closest(".feature-reveal")).toBeNull();
  });
});
