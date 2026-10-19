import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useKeyboardInset } from "./use-keyboard-inset";

afterEach(() => vi.unstubAllGlobals());

function mockViewport(innerHeight: number, height: number, offsetTop = 0) {
  const target = new EventTarget();
  const vv = Object.assign(target, { height, offsetTop });
  vi.stubGlobal("innerHeight", innerHeight);
  vi.stubGlobal("visualViewport", vv);
  return vv;
}

describe("useKeyboardInset", () => {
  it("is closed without visualViewport", () => {
    vi.stubGlobal("visualViewport", undefined);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toEqual({ inset: 0, visibleHeight: null });
  });

  it("reports the keyboard height and follows resize and scroll", () => {
    const vv = mockViewport(800, 500);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current).toEqual({ inset: 300, visibleHeight: 500 });
    act(() => {
      vv.height = 450;
      vv.offsetTop = 20;
      vv.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.inset).toBe(330);
    act(() => {
      vv.height = 800;
      vv.offsetTop = 0;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toEqual({ inset: 0, visibleHeight: null });
  });

  it("never goes negative", () => {
    mockViewport(800, 900);
    const { result } = renderHook(() => useKeyboardInset());
    expect(result.current.inset).toBe(0);
  });
});
