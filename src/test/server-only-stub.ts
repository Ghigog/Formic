/**
 * Stand-in for the `server-only` package under Vitest. The real module throws
 * when imported outside a React Server Component; the Next.js build is what
 * actually enforces the boundary.
 */
export {};
