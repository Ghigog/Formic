import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createRef } from "react";
import { render, screen } from "@testing-library/react";
import { DigTransition, type DigTransitionHandle } from "./dig-transition";

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

const phase = () => screen.getByTestId("dig-transition").dataset.phase;

beforeEach(() => {
  vi.useFakeTimers();
  mockMatchMedia(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DigTransition", () => {
  it("leaves, digs until the load resolves, enters, then idles", async () => {
    const ref = setup();
    let resolve!: () => void;
    const load = new Promise<void>((r) => (resolve = r));
    act(() => void ref.current!.swap("down", load));
    expect(phase()).toBe("leaving");
    expect(document.querySelector(".dig-board")?.getAttribute("data-direction")).toBe("down");

    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(phase()).toBe("digging");
    expect(screen.getByTestId("dig-band")).toBeTruthy();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(phase()).toBe("digging");

    await act(async () => resolve());
    expect(phase()).toBe("entering");
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(phase()).toBe("idle");
  });

  it("brings the old board back when the load fails", async () => {
    const ref = setup();
    let reject!: () => void;
    const load = new Promise<void>((_, r) => (reject = r));
    act(() => void ref.current!.swap("down", load));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(phase()).toBe("digging");
    await act(async () => reject());
    expect(phase()).toBe("idle");
    expect(screen.queryByTestId("dig-band")).toBeNull();
    expect(screen.getByText("board")).toBeTruthy();
  });

  it("bounces briefly and stays", async () => {
    const ref = setup();
    act(() => ref.current!.bounce("up"));
    expect(phase()).toBe("bouncing");
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(phase()).toBe("idle");
  });

  it("shows no dirt band under reduced motion", async () => {
    mockMatchMedia(true);
    const ref = setup();
    act(() => void ref.current!.swap("down", Promise.resolve()));
    expect(screen.queryByTestId("dig-band")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByTestId("dig-band")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(phase()).toBe("idle");
  });
});
