import { vi } from "vitest";

/**
 * jsdom has no `matchMedia`, and `useMediaQuery` calls it on mount, so the
 * board would throw on render without this. Tests that care about the mobile
 * layout set the answer with `setViewportMatches(true)`; the rest get the
 * desktop board.
 *
 * Note this answers every query the same way. That is honest for now — the
 * app asks exactly one question, `(max-width: 767px)` — and a test that needs
 * per-query answers should say so rather than inherit a guess.
 */

let matches = false;

export function setViewportMatches(value: boolean): void {
  matches = value;
}

export function resetViewport(): void {
  matches = false;
}

export function installMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  });
}
