import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createRef } from "react";
import { render, screen } from "@testing-library/react";
import { DigTransition, ENTER_MS, LEAVE_MS, MIN_DIG_MS, type DigTransitionHandle } from "./dig-transition";

const mockMatchMedia = (reduced: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }));

const setup = () => {
  const ref = createRef<DigTransitionHandle>();
  render(
    <DigTransition ref={ref}>
      <p>board</p>
    </DigTransition>,
  );
  return ref;
};

const stage = () => screen.getByTestId("dig-transition");
const phase = () => stage().dataset.phase;

beforeEach(() => {
  vi.useFakeTimers();
  mockMatchMedia(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DigTransition", () => {
  it("leaves into the earth, digs until the load resolves, brings the new board in, then idles", async () => {
    const ref = setup();
    let resolve!: (v: string) => void;
    const load = new Promise<string>((r) => (resolve = r));
    const arrive = vi.fn();
    act(() => void ref.current!.swap("down", load, arrive, "Formic"));
    expect(phase()).toBe("leaving");
    expect(stage().dataset.direction).toBe("down");
    expect(screen.getByTestId("dig-band")).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(LEAVE_MS));
    expect(phase()).toBe("digging");
    expect(screen.getByText("Formic")).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Formic");

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(phase()).toBe("digging");
    expect(arrive).not.toHaveBeenCalled();

    await act(async () => resolve("next board"));
    expect(arrive).toHaveBeenCalledWith("next board");
    expect(phase()).toBe("entering");
    await act(() => vi.advanceTimersByTimeAsync(ENTER_MS));
    expect(phase()).toBe("idle");
    expect(screen.queryByTestId("dig-band")).toBeNull();
  });

  it("sounds like digging: into the soil, grit while it loads, and out again", async () => {
    const sounds: string[] = [];
    const ref = createRef<DigTransitionHandle>();
    render(
      <DigTransition ref={ref} onSound={(s) => sounds.push(s)}>
        <p>board</p>
      </DigTransition>,
    );
    let resolve!: () => void;
    act(() => void ref.current!.swap("down", new Promise<void>((r) => (resolve = r)), () => {}));
    expect(sounds).toEqual(["dig"]);
    await act(() => vi.advanceTimersByTimeAsync(LEAVE_MS + 600));
    expect(sounds.filter((s) => s === "grit").length).toBeGreaterThan(1);
    await act(async () => resolve());
    expect(sounds.at(-1)).toBe("surface");
    const gritted = sounds.length;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(sounds).toHaveLength(gritted);
  });

  it("stays in the earth a moment even when the board loads at once", async () => {
    const ref = setup();
    act(() => void ref.current!.swap("down", Promise.resolve(1), () => {}));
    await act(() => vi.advanceTimersByTimeAsync(LEAVE_MS));
    expect(phase()).toBe("digging");
    await act(() => vi.advanceTimersByTimeAsync(MIN_DIG_MS - 50));
    expect(phase()).toBe("digging");
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(phase()).toBe("entering");
  });

  it("brings the old board back up out of the earth when the load fails, and says it did not arrive", async () => {
    const ref = setup();
    let reject!: () => void;
    const load = new Promise<void>((_, r) => (reject = r));
    let arrived: boolean | undefined;
    act(() => void ref.current!.swap("down", load, () => {}).then((a) => (arrived = a)));
    await act(() => vi.advanceTimersByTimeAsync(LEAVE_MS));
    await act(async () => reject());
    await act(() => vi.advanceTimersByTimeAsync(MIN_DIG_MS));
    expect(phase()).toBe("entering");
    expect(stage().dataset.direction).toBe("up");
    await act(() => vi.advanceTimersByTimeAsync(ENTER_MS));
    expect(phase()).toBe("idle");
    expect(arrived).toBe(false);
    expect(screen.getByText("board")).toBeTruthy();
  });

  it("follows a gesture with the earth showing at the board's edge, and lets go", () => {
    const ref = setup();
    act(() => ref.current!.pull(-40));
    expect(stage()).toHaveAttribute("data-pulling");
    expect(stage().dataset.direction).toBe("down");
    expect(stage().style.getPropertyValue("--dig-pull")).toBe("-40px");
    expect(screen.getByTestId("dig-band")).toBeTruthy();
    act(() => ref.current!.pull(null));
    expect(stage()).not.toHaveAttribute("data-pulling");
    expect(screen.queryByTestId("dig-band")).toBeNull();
  });

  it("bounces against the soil and stays", async () => {
    const ref = setup();
    act(() => ref.current!.bounce("up"));
    expect(phase()).toBe("bouncing");
    await act(() => vi.advanceTimersByTimeAsync(420));
    expect(phase()).toBe("idle");
  });

  it("crossfades with no earth under reduced motion", async () => {
    mockMatchMedia(true);
    const ref = setup();
    act(() => void ref.current!.swap("down", Promise.resolve(), () => {}));
    expect(screen.queryByTestId("dig-band")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByTestId("dig-band")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(phase()).toBe("idle");
  });
});
