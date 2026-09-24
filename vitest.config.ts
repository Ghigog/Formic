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
          testTimeout: 15_000,
        },
      },
    ],
  },
});
