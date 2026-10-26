import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AutoTour, Tour, TourHost } from "./tour";
import { endTour, hasSeen, replayTours, startTour } from "./store";
import type { TourDef } from "./tours";
import { speaks, syllable } from "./voice";

/**
 * The guided tour: it finds what each step points at, talks about it, skips
 * what is not on screen, and remembers which tours this browser has seen.
 */

/** A tour target with a real-looking box: jsdom lays nothing out. */
function target(name: string, box = { x: 100, y: 100, w: 200, h: 80 }) {
  const el = document.createElement("div");
  el.setAttribute("data-tour", name);
  el.getBoundingClientRect = () =>
    ({ left: box.x, top: box.y, width: box.w, height: box.h, right: box.x + box.w, bottom: box.y + box.h, x: box.x, y: box.y, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

/** Shown in the DOM but laid out at zero size, like a desktop control on a phone. */
function hiddenTarget(name: string) {
  const el = document.createElement("div");
  el.setAttribute("data-tour", name);
  document.body.appendChild(el);
  return el;
}

const def: TourDef = {
  id: "board",
  steps: [
    { target: "one", side: "below", title: "First", text: "The first thing." },
    { target: "phone-hidden", side: "below", title: "Hidden", text: "Not on this screen." },
    { target: "two", side: "right", title: "Second", text: "The second thing." },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
  // Reduced motion: the ant jumps and each line appears whole, so a test
  // reads the bubble without waiting on the walk or the typing.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  window.localStorage.clear();
});

afterEach(() => {
  act(() => endTour());
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });

describe("Tour", () => {
  it("talks about each step in turn, skipping one whose target is hidden", async () => {
    target("one");
    hiddenTarget("phone-hidden");
    target("two");
    const onEnd = vi.fn();
    render(<Tour def={def} onEnd={onEnd} />);
    await flush();

    expect(screen.getByRole("dialog", { name: "Tour: First" })).toBeTruthy();
    expect(screen.getByText("The first thing.")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Tour: Second" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("goes back a step", async () => {
    target("one");
    target("phone-hidden");
    render(<Tour def={def} onEnd={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(screen.getByText("Not on this screen.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await flush();
    expect(screen.getByText("The first thing.")).toBeTruthy();
  });

  it("ends on Skip and on Escape", async () => {
    target("one");
    const onEnd = vi.fn();
    render(<Tour def={def} onEnd={onEnd} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("waits for the person to act on a waiting step, with no Next button", async () => {
    target("login");
    render(
      <Tour
        def={{ id: "login", steps: [{ target: "login", side: "left", title: "Welcome", text: "Sign in.", waitFor: "Sign in to carry on" }] }}
        onEnd={() => {}}
      />,
    );
    await flush();
    expect(screen.getByText("Sign in to carry on")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("walks into the nest at the end of a tour that ends there", async () => {
    target("one");
    target("colony", { x: 1300, y: 860, w: 40, h: 36 });
    const onEnd = vi.fn();
    render(<Tour def={{ id: "board", endInNest: true, steps: [def.steps[0]!] }} onEnd={onEnd} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("mutes the ant without touching anything else", async () => {
    target("one");
    render(<Tour def={def} onEnd={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Mute the ant" }));
    expect(window.localStorage.getItem("formic:tours:voice")).toBe("off");
    expect(screen.getByRole("button", { name: "Let the ant talk" })).toBeTruthy();
  });
});

describe("AutoTour and the host", () => {
  it("plays a screen's tour the first time only", async () => {
    target("examples");
    const { unmount } = render(
      <>
        <TourHost />
        <AutoTour id="pick" delay={0} />
      </>,
    );
    await flush();
    expect(screen.getByRole("dialog", { name: "Tour: Pick a project" })).toBeTruthy();
    expect(hasSeen("pick")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    unmount();
    render(
      <>
        <TourHost />
        <AutoTour id="pick" delay={0} />
      </>,
    );
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("waits while another tour runs", async () => {
    target("examples");
    act(() => startTour("timeline"));
    render(<AutoTour id="pick" delay={0} />);
    await flush();
    expect(hasSeen("pick")).toBe(false);
  });

  it("replays from the board, and asks to go there from anywhere else", () => {
    window.localStorage.setItem("formic:tours:seen", JSON.stringify(["board", "timeline"]));
    expect(replayTours()).toBe(false);
    expect(hasSeen("timeline")).toBe(false);

    target("column");
    expect(replayTours()).toBe(true);
    expect(hasSeen("board")).toBe(true);
  });
});

describe("the ant's voice", () => {
  it("mutters every third letter, never on spaces or punctuation", () => {
    expect(speaks("a", 3)).toBe(true);
    expect(speaks("a", 4)).toBe(false);
    expect(speaks(" ", 3)).toBe(false);
    expect(speaks(",", 6)).toBe(false);
  });

  it("gives the same letter the same syllable", () => {
    expect(syllable("k")).toEqual(syllable("K"));
    expect(syllable("a").freq).toBeGreaterThan(0);
  });
});
