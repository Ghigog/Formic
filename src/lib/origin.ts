/**
 * The board's public address, as FORMIC_URL sets it, or null when unset.
 *
 * Behind a reverse proxy (Caddy on a server, deploy/server/setup.sh), Next
 * builds `req.url` from the address it listens on, so a request for
 * https://board.example.com arrives as https://localhost:3000. Redirects and
 * the GitHub sign-in callback built from it send people nowhere. On Vercel
 * and in development `req.url` is already the public address.
 */
export function configuredOrigin(): string | null {
  const explicit = process.env.FORMIC_URL?.trim().replace(/\/+$/, "");
  return explicit || null;
}

/** `path` on the board's public address, or on the request's own when none is set. */
export function publicUrl(path: string, req: Request): URL {
  return new URL(path, configuredOrigin() ?? req.url);
}
