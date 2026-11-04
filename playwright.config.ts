import { defineConfig, devices } from "@playwright/test";
import { TOURS } from "./src/components/onboarding/tours";

const PORT = Number(process.env.E2E_PORT ?? 3210);
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * A second server on the same build, in accounts mode: email sign-in with
 * the console mailer, which appends each email to ACCOUNTS_OUTBOX for
 * e2e/accounts.spec.ts to read. No GitHub App, so nobody here can sign in
 * any way but email.
 */
export const ACCOUNTS_PORT = PORT + 1;
const accountsURL = `http://127.0.0.1:${ACCOUNTS_PORT}`;
export const ACCOUNTS_OUTBOX = `${process.cwd()}/e2e/.results/outbox.jsonl`;

/**
 * Chromium is pre-installed in some environments (CI images, the agent
 * sandbox) rather than downloaded by Playwright. Point at it with
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE instead of running `playwright install`.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const launchOptions = executablePath ? { executablePath } : {};

/**
 * CI builds once, in its own job, and hands the output to this one: set
 * E2E_SKIP_BUILD=1 to start the server on the `.next` already in place.
 */
const buildFirst = process.env.E2E_SKIP_BUILD === "1" ? "" : "npm run build && ";

/**
 * Every browser starts with the guided tours already seen.
 *
 * A fresh browser plays the board's tour a moment after the page loads, at
 * a time no test controls. Its overlay is costly to paint on CI's CPU
 * rasteriser, and a test that drags or clicks while it walks in stalls for
 * most of a second per move. The tours have their own unit tests; no spec
 * here is about them.
 */
const storageState = {
  cookies: [],
  origins: [
    {
      origin: baseURL,
      localStorage: [{ name: "formic:tours:seen", value: JSON.stringify(Object.keys(TOURS)) }],
    },
  ],
};

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
  // No retries: a test that passes on its second try is a flaky test, and a
  // retry would turn it green instead of reporting it.
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions,
    storageState,
  },

  projects: [
    {
      name: "desktop",
      testIgnore: /(mobile|accounts)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 980 } },
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "accounts",
      testMatch: /accounts\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 980 },
        baseURL: accountsURL,
        storageState: { cookies: [], origins: [{ ...storageState.origins[0]!, origin: accountsURL }] },
      },
    },
  ],

  /*
   * A production build, not `next dev`. The dev server compiles on first
   * request, which turns the first assertion of every run into a timeout
   * race, and it is not the artefact that ships.
   */
  webServer: [{
    command: `${buildFirst}npx next start -p ${PORT}`,
    /*
     * The board's agents run as mocks here, and this is the only reason they
     * do: mocks are never chosen implicitly (see src/lib/agents/mock-mode).
     * Without this the suite's columns have no agent and every pipeline test
     * would stall instead of running.
     */
    env: { ...process.env, AGENT_PROVIDER: "mock" } as Record<string, string>,
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
  }, {
    // Waits for the first server, so it starts on the build that one made.
    command: `until curl -sf ${baseURL}/api/health >/dev/null; do sleep 1; done; rm -f ${ACCOUNTS_OUTBOX}; npx next start -p ${ACCOUNTS_PORT}`,
    env: {
      ...process.env,
      AGENT_PROVIDER: "mock",
      GITHUB_APP_CLIENT_ID: "",
      GITHUB_APP_CLIENT_SECRET: "",
      FORMIC_MAILER: "console",
      FORMIC_MAILER_OUTBOX: ACCOUNTS_OUTBOX,
      FORMIC_URL: accountsURL,
      FORMIC_SECRET: "e2e-accounts-secret-at-least-32-bytes",
      FORMIC_ALLOWED_USERS: "",
    } as Record<string, string>,
    url: `${accountsURL}/api/health`,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  }],
});
