import { test as base } from "@playwright/test";
import { E2E_SERVERS } from "./servers";

export { expect } from "@playwright/test";
export type { Locator, Page } from "@playwright/test";

/**
 * The test every spec uses: Playwright's own, with each worker sent to a
 * server of its own. Every server keeps its own in-memory board, so two
 * workers never move each other's cards (see `workers` in
 * playwright.config.ts). The accounts project keeps the accounts server.
 */
export const test = base.extend({
  baseURL: async ({ baseURL }, provide, testInfo) => {
    if (testInfo.project.name === "accounts") return provide(baseURL);
    return provide(E2E_SERVERS[testInfo.parallelIndex % E2E_SERVERS.length]);
  },
});
