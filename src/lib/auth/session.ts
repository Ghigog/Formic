/**
 * Who is signed in, and how sign-in works on this deployment.
 *
 * Two modes, chosen by configuration:
 *
 *  - github: GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are set.
 *    Everyone signs in with GitHub, and the session cookie names their user,
 *    signed with FORMIC_SECRET.
 *  - local: no GitHub App. One implicit user, no sign-in, which is how the
 *    app runs on a laptop and in tests. FORMIC_PASSWORD, if set, still puts
 *    a shared password in front of it.
 *
 * Web Crypto only, so the proxy and route handlers share this file.
 */

export const SESSION_COOKIE = "formic_session";
/** Thirty days. A GitHub token behind it refreshes on its own. */
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export type AuthMode = "github" | "local";

export function authMode(): AuthMode {
  return process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET
    ? "github"
    : "local";
}

export function gatePassword(): string | null {
  return process.env.FORMIC_PASSWORD || null;
}

/** Key material for signing. The same fallback chain as the vault. */
export function signingSecret(): string {
  return (
    process.env.FORMIC_SECRET ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    "formic-local-only"
  );
}

async function hmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison, so a wrong guess leaks nothing by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Local mode's shared password. */

export async function passwordToken(password: string): Promise<string> {
  return hmac(password, "formic-session-v1");
}

/* GitHub mode's per-user session: `<userId>.<expiry>.<signature>`. */

export async function signSession(userId: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_MAX_AGE_S;
  const body = `${userId}.${expires}`;
  return `${body}.${await hmac(signingSecret(), `session:${body}`)}`;
}

/** The user a session cookie names, or null if it is forged or expired. */
export async function verifySession(
  cookie: string | undefined,
  now = Date.now(),
): Promise<string | null> {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, sig] = parts as [string, string, string];
  if (!userId || !/^\d+$/.test(expires)) return null;
  if (Number(expires) * 1000 < now) return null;
  const expected = await hmac(signingSecret(), `session:${userId}.${expires}`);
  return safeEqual(sig, expected) ? userId : null;
}

/** Signs a short-lived value, for the OAuth state round trip. */
export async function signValue(value: string): Promise<string> {
  return `${value}.${await hmac(signingSecret(), `value:${value}`)}`;
}

export async function verifyValue(signed: string | undefined): Promise<string | null> {
  if (!signed) return null;
  const at = signed.lastIndexOf(".");
  if (at <= 0) return null;
  const value = signed.slice(0, at);
  const expected = await hmac(signingSecret(), `value:${value}`);
  return safeEqual(signed.slice(at + 1), expected) ? value : null;
}

export function cookieHeader(name: string, value: string, maxAgeS: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeS}; SameSite=Lax; HttpOnly${
    process.env.NODE_ENV === "production" ? "; Secure" : ""
  }`;
}

/** Holds the OAuth state between leaving for GitHub and coming back. */
export const OAUTH_COOKIE = "formic_oauth";

/** Only same-site paths, so sign-in cannot bounce someone elsewhere. */
export function safeNext(raw: string | null | undefined): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}
