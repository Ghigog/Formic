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

/**
 * Whether a form POST came from one of this board's own pages. Browsers say
 * so in Sec-Fetch-Site; older ones only send Origin, which is compared with
 * the public address and the Host the request arrived on. Stops another site
 * from posting a sign-in form on a visitor's behalf.
 */
export function fromOwnPage(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  return (
    origin === publicUrl("/", req).origin ||
    origin === new URL(req.url).origin ||
    (!!host && new URL(origin).host === host)
  );
}
