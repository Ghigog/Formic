import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRestoreFocus } from "./use-restore-focus";

afterEach(() => {
  document.body.innerHTML = "";
});

function opener() {
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  return button;
}

describe("useRestoreFocus", () => {
  it("returns focus to the opener when the dialog closes", () => {
    const button = opener();
    const { rerender } = renderHook(({ open }) => useRestoreFocus(open), { initialProps: { open: false } });
    rerender({ open: true });
    button.blur();
    expect(button).not.toHaveFocus();
    rerender({ open: false });
    expect(button).toHaveFocus();
  });

  it("returns focus when unmounted while open", () => {
    const button = opener();
    const { unmount } = renderHook(() => useRestoreFocus(true));
    button.blur();
    unmount();
    expect(button).toHaveFocus();
  });

  it("leaves focus alone when the opener was removed", () => {
    const button = opener();
    const other = document.createElement("input");
    document.body.append(other);
    const { rerender } = renderHook(({ open }) => useRestoreFocus(open), { initialProps: { open: true } });
    other.focus();
    button.remove();
    expect(() => rerender({ open: false })).not.toThrow();
    expect(other).toHaveFocus();
  });

  it("does not restore while the dialog stays open", () => {
    const button = opener();
    const { rerender } = renderHook(({ open }) => useRestoreFocus(open), { initialProps: { open: true } });
    button.blur();
    rerender({ open: true });
    expect(button).not.toHaveFocus();
  });
});
