import "@testing-library/jest-dom/vitest";
import type { EventEmitter } from "node:events";
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

/**
 * jsdom has no canvas and logs "Not implemented" on every getContext call.
 * Returning null is what a browser without canvas support does.
 */
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

/**
 * jsdom reports `location.href = …` and `location.reload()` as "Not
 * implemented: navigation" and ignores them. `location` cannot be replaced in
 * the shared window, so drop just that report; other jsdom errors still print.
 */
const { virtualConsole } = (globalThis as unknown as { jsdom: { virtualConsole: EventEmitter } }).jsdom;
virtualConsole.removeAllListeners("jsdomError");
virtualConsole.on("jsdomError", (error: Error) => {
  if (error.message.includes("Not implemented: navigation")) return;
  console.error(error);
});
