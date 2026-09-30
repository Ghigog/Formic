import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { SOUND_KEY, useSound } from "./store";

afterEach(() => window.localStorage.clear());

describe("useSound", () => {
  it("is on until switched off", () => {
    const { result } = renderHook(() => useSound());
    expect(result.current[0]).toBe(true);
  });

  it("persists the choice under its own key", () => {
    const { result } = renderHook(() => useSound());
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem(SOUND_KEY)).toBe("off");
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });

  it("follows a change made in another tab and is shared between hooks", () => {
    const a = renderHook(() => useSound());
    const b = renderHook(() => useSound());
    act(() => a.result.current[1](false));
    expect(b.result.current[0]).toBe(false);
    act(() => {
      window.localStorage.setItem(SOUND_KEY, "on");
      window.dispatchEvent(new StorageEvent("storage", { key: SOUND_KEY }));
    });
    expect(a.result.current[0]).toBe(true);
  });
});
