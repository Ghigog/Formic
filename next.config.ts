import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: true,
  /**
   * The loop entry a job runs is a build artifact (`npm run build` produces it
   * with scripts/build-loop-entry.mjs before Next compiles), so the function
   * that serves it has to carry the file with it: nothing imports it, and a
   * tracer cannot see a file read at runtime.
   */
  outputFileTracingIncludes: {
    "/api/runner/bundle": ["./src/generated/loop-entry/**"],
  },
};

export default nextConfig;
