import type { NextConfig } from "next";

/**
 * The headers every response carries. They're set here rather than in a
 * middleware so they apply to everything the server sends, including routes
 * the middleware skips.
 *
 * HSTS is unconditional: https is how a deploy is reached, and a local
 * `next dev` over http just ignores the header until it matters.
 *
 * The CSP is deliberately tight, and lists exactly what the app loads:
 * Google Fonts' stylesheet and font files (the artboards' three families),
 * GitHub avatars and the same-origin attachment previews, the board's
 * event stream, and inline styles from Next's own compiled CSS output.
 * Anything a script or a frame needs is left out on purpose. With Supabase
 * Realtime set up, the board also connects to the Supabase project
 * (src/lib/events/realtime.ts).
 */
const realtimeOrigins = (() => {
  const raw = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  try {
    const { protocol, host } = new URL(raw);
    return protocol === "https:" ? [`https://${host}`, `wss://${host}`] : [];
  } catch {
    return [];
  }
})();

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://avatars.githubusercontent.com",
      ["connect-src 'self'", ...realtimeOrigins].join(" "),
      "object-src 'none'",
    ].join("; "),
  },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
