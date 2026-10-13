import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { installMatchMedia, resetViewport } from "./viewport";

/**
 * Setup for the jsdom project. Everything here exists because jsdom is not a
 * browser, not because the app needs it.
 */

installMatchMedia();

/**
 * The dom project runs on `pool: "vmThreads"` (vitest.config.ts), where
 * files share a worker thread. Put the window back the way a fresh jsdom
 * would have it after every test, so nothing can leak between tests or files.
 */
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  document.body.removeAttribute("class");
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("style");
  document.title = "";
  localStorage.clear();
  sessionStorage.clear();
  resetViewport();
  installMatchMedia();
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
