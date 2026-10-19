import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  // `server-only` throws on import outside a React Server Component. Under
  // Vitest there is no such distinction, so it resolves to a no-op; the
  // guard still does its job in the Next.js build, which is where a client
  // import would actually be a leak.
  "server-only": fileURLToPath(
    new URL("./src/test/server-only-stub.ts", import.meta.url),
  ),
};

/**
 * Two projects, split by file extension rather than directory.
 *
 *   *.test.ts   node      domain rules, ordering, budgets, repositories
 *   *.test.tsx  jsdom     components, wired together where it is cheap to
 *
 * The split is by extension because it is impossible to get wrong: a test
 * that renders a component has to be .tsx to hold the JSX, and therefore
 * lands in the jsdom project automatically. A domain test cannot drift into
 * jsdom by accident, which matters — `src/lib/domain` is deliberately free of
 * framework and I/O, and running it in a browser-shaped environment would
 * hide an import that broke that.
 *
 * Anything needing real layout, a real event loop across a drag, or a real
 * server is an end-to-end test instead. See e2e/ and docs/testing.md.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    // Off unless asked for (`--coverage`): CI asks, and uploads the summary
    // for the Tester sentinel to read. See docs/sentinels.md.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/generated/**",
        // Only exercised by the Postgres half of the contract suite, which
        // needs TEST_DATABASE_URL. Without it the file would count as
        // uncovered, so local runs would measure less than CI does.
        ...(process.env.TEST_DATABASE_URL
          ? []
          : ["src/lib/db/prisma-repository.ts"]),
      ],
      reporter: ["json-summary", "text-summary"],
      // A floor, not a target. CI runs with `--coverage`; a change that drops
      // below these — even one that only removes a test's reach — turns the
      // `test` check red. Set just under where the suite is today so a small
      // legitimate drift does not fail it, while a real regression still does.
      // (Measured without TEST_DATABASE_URL, which also leaves
      // prisma-repository.ts out of the count, so local and CI agree.)
      thresholds: {
        lines: 76,
        statements: 73,
        branches: 68,
        functions: 72,
      },
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts"],
          setupFiles: ["./src/test/setup-env.ts"],
          testTimeout: 15_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup-env.ts", "./src/test/setup-dom.ts"],
          // Run each file in a VM context on a shared worker thread instead of
          // a fresh worker per file; modules stay per-file, so vi.mock still
          // works. setup-dom.ts resets DOM state as a guard against leakage.
          pool: "vmThreads",
          testTimeout: 15_000,
        },
      },
    ],
  },
});
