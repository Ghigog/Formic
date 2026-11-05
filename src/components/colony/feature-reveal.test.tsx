import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureReveal } from "./feature-reveal";
import { SoundEngine } from "./sound";

function setup(opts: { reduced?: boolean; audible?: boolean } = {}) {
  vi.stubGlobal("matchMedia", () => ({ matches: !!opts.reduced }));
  const sound = new SoundEngine();
  const play = vi.spyOn(sound, "play").mockImplementation(() => {});
  vi.spyOn(sound, "whenAudible").mockImplementation((f) => {
    if (opts.audible !== false) f();
  });
  return { sound, play };
}

const phase = () =>
  screen
    .getByText("Timeline")
    .closest(".feature-reveal")
    ?.getAttribute("data-phase");

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FeatureReveal", () => {
  it("renders the child untouched when nothing is being revealed", () => {
    const { sound } = setup();
    render(
      <FeatureReveal reveal={false} sound={sound}>
        <button>Timeline</button>
      </FeatureReveal>,
    );
    expect(phase()).toBeUndefined();
  });

  it("clears a space, rises with ring and burst, cues once and settles once", () => {
    const { sound, play } = setup();
    const onSettled = vi.fn();
    const { container } = render(
      <FeatureReveal reveal sound={sound} onSettled={onSettled}>
        <button>Timeline</button>
      </FeatureReveal>,
    );
    expect(phase()).toBe("space");
    expect(play).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(220));
    expect(phase()).toBe("rise");
    expect(container.querySelector(".feature-reveal-ring")).not.toBeNull();
    expect(container.querySelector(".feature-reveal-burst")).not.toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith("celebrate");
    expect(onSettled).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(460));
    expect(phase()).toBe("done");
    act(() => void vi.advanceTimersByTime(2000));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("only fades under reduced motion, and the cue still plays", () => {
    const { sound, play } = setup({ reduced: true });
    const onSettled = vi.fn();
    render(
      <FeatureReveal reveal sound={sound} onSettled={onSettled}>
        <button>Timeline</button>
      </FeatureReveal>,
    );
    expect(phase()).toBe("fade");
    expect(play).toHaveBeenCalledWith("celebrate");
    act(() => void vi.advanceTimersByTime(150));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("plays no cue with sound off", () => {
    const sound = new SoundEngine();
    sound.setEnabled(false);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const ac = vi.fn();
    vi.stubGlobal("AudioContext", ac);
    const onSettled = vi.fn();
    render(
      <FeatureReveal reveal sound={sound} onSettled={onSettled}>
        <button>Timeline</button>
      </FeatureReveal>,
    );
    act(() => void vi.advanceTimersByTime(700));
    expect(ac).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("holds the cue until the page can be heard", () => {
    const { sound, play } = setup({ audible: false });
    render(
      <FeatureReveal reveal sound={sound}>
        <button>Timeline</button>
      </FeatureReveal>,
    );
    act(() => void vi.advanceTimersByTime(700));
    expect(play).not.toHaveBeenCalled();
  });
});
