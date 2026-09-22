import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3210);
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * Chromium is pre-installed in some environments (CI images, the agent
 * sandbox) rather than downloaded by Playwright. Point at it with
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE instead of running `playwright install`.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const launchOptions = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.results",

  /*
   * One worker, no parallelism, and this is deliberate.
   *
   * The board these tests drive has one server process and, without a
   * DATABASE_URL, one in-memory store. Two workers would be moving cards on
   * the same board and reading each other's writes. Tests that mutate put
   * the card back where they found it — see e2e/board.ts — which only works
   * if nothing else is moving at the same time.
   *
   * If this ever gets slow enough to matter, the fix is a database per
   * worker, not more workers against one store.
   */
  workers: 1,
  fullyParallel: false,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions,
  },

  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 980 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],

  /*
   * A production build, not `next dev`. The dev server compiles on first
   * request, which turns the first assertion of every run into a timeout
   * race, and it is not the artefact that ships.
   */
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `${baseURL}/api/health`,
    /*
     * A fresh server, and therefore a fresh in-memory store, for every run.
     *
     * Reusing one would mean each run starts on the board the last run left
     * behind — cards in other columns, captures that were never deleted —
     * and the failures that causes look like app bugs. Set E2E_REUSE_SERVER=1
     * to point the suite at a server you are already running, and accept
     * that you own its state.
     */
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
