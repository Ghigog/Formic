import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDraft } from "./use-draft";

const KEY = "formic:draft:v1:a";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("useDraft", () => {
  it("persists what is typed", () => {
    const { result } = renderHook(() => useDraft("a"));
    act(() => result.current[1]("hello"));
    expect(result.current[0]).toBe("hello");
    expect(window.localStorage.getItem(KEY)).toBe("hello");
  });

  it("restores the saved draft on mount, and only for its own scope", () => {
    window.localStorage.setItem(KEY, "kept");
    expect(renderHook(() => useDraft("a")).result.current[0]).toBe("kept");
    expect(renderHook(() => useDraft("b")).result.current[0]).toBe("");
  });

  it("clears the stored entry when emptied", () => {
    window.localStorage.setItem(KEY, "kept");
    const { result } = renderHook(() => useDraft("a"));
    act(() => result.current[1](""));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("works as plain state when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useDraft("a"));
    act(() => result.current[1]("typed"));
    expect(result.current[0]).toBe("typed");
  });
});
