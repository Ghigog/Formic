import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { installMatchMedia, resetViewport } from "./viewport";

/**
 * Setup for the jsdom project. Everything here exists because jsdom is not a
 * browser, not because the app needs it.
 */

installMatchMedia();

afterEach(() => {
  cleanup();
  resetViewport();
});

/**
 * @hello-pangea/dnd observes its droppables on mount. jsdom reports every box
 * as 0×0, which is harmless for these tests — the library still registers its
 * elements and emits the data attributes the component tests assert on. A
 * real drag needs real layout, so it is covered end to end instead.
 */
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
