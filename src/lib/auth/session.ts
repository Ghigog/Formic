/**
 * The optional password in front of the whole app.
 *
 * Off unless FORMIC_PASSWORD is set. When it is, the session cookie holds an
 * HMAC of a fixed label under the password: nothing to store server-side,
 * and changing the password signs everyone out. Web Crypto only, so the same
 * code runs in the proxy and in route handlers.
 */

export const SESSION_COOKIE = "formic_session";

export function gatePassword(): string | null {
  return process.env.FORMIC_PASSWORD || null;
}

export async function sessionToken(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("formic-session-v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison, so a wrong guess leaks nothing by timing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
