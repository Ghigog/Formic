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

/**
 * The origin a link sent outside the browser (an email) may point at, or
 * null when there is none to trust.
 *
 * Never the request's own address on a self-hosted server: Next builds it
 * from the Host header, which whoever sends the request chooses. A sign-in
 * link built from it could carry a real token to someone else's domain. So:
 * FORMIC_URL when set; on Vercel, which only routes the project's own
 * domains, the request's address; in development, the request's address.
 */
export function trustedLinkOrigin(req: Request): string | null {
  const explicit = configuredOrigin();
  if (explicit) return new URL(explicit).origin;
  if (process.env.VERCEL || process.env.NODE_ENV !== "production") return new URL(req.url).origin;
  return null;
}
