"use client";

import { useCallback, type KeyboardEvent } from "react";

const TABBABLE =
  'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable=""], [contenteditable="true"], [tabindex]';

function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest("[hidden], [inert]")) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

/**
 * Keeps Tab inside a modal dialog and handles Escape on the dialog itself.
 * Spread the returned handler on the element with role="dialog". It is a React
 * handler on purpose: nested popovers stop propagation in their own onKeyDown,
 * and React propagation follows portals, which a native listener would not.
 */
export function useFocusTrap({ onEscape }: { onEscape?: () => void } = {}) {
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
        onEscape?.();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = event.currentTarget;
      const tabbable = Array.from(dialog.querySelectorAll<HTMLElement>(TABBABLE)).filter(isTabbable);
      const active = document.activeElement;
      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1] ?? first;

      if (!first) {
        event.preventDefault();
        event.stopPropagation();
        dialog.focus();
        return;
      }
      const outside = active === dialog || !(active instanceof Node && dialog.contains(active));
      if (event.shiftKey ? outside || active === first : outside || active === last) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey ? last : first)?.focus();
      }
    },
    [onEscape],
  );
}
