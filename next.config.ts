import type { NextConfig } from "next";

/**
 * The headers every response carries. They're set here rather than in a
 * middleware so they apply to everything the server sends, including routes
 * the proxy skips.
 *
 * HSTS is unconditional: https is how a deploy is reached, and a local
 * `next dev` over http just ignores the header until it matters.
 *
 * The Content-Security-Policy carries a per-request nonce, so it is set in
 * src/proxy.ts instead.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  typedRoutes: true,
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
