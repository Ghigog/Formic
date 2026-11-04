import { randomBytes } from "node:crypto";
import { authorizeUrl, appConfig } from "@/lib/auth/github";
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  cookieHeader,
  safeNext,
  secretProblem,
  signValue,
} from "@/lib/auth/session";
import { userForSession } from "@/lib/auth/user";
import { limit, limited } from "@/lib/rate-limit";
import { publicUrl } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** Ten sign-ins a minute from one address: the state round trip isn't free. */
const SIGN_IN = limit(10, 60_000);

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/**
 * Starts the GitHub round trip: remembers where to come back to, then off to
 * GitHub. `?intent=connect` is someone already signed in (by email, say)
 * connecting GitHub to their account; the state then names them, so the
 * callback attaches GitHub to that account and to no other.
 */
export async function GET(req: Request) {
  const refused = limited(req, SIGN_IN, "github-login");
  if (refused) return refused;

  const url = new URL(req.url);
  if (!appConfig()) return Response.redirect(publicUrl("/", req), 303);

  // Without a real FORMIC_SECRET, the state cookie (and the session it leads
  // to) would be signed with a guessable fallback key.
  const problem = secretProblem();
  if (problem) {
    const back = publicUrl("/login", req);
    back.searchParams.set("error", problem);
    return Response.redirect(back, 303);
  }

  const connect = url.searchParams.get("intent") === "connect";
  const nonce = randomBytes(16).toString("hex");
  const next = safeNext(url.searchParams.get("next") ?? (connect ? "/settings" : null));
  let state = `${nonce}|${next}`;
  if (connect) {
    const user = await userForSession(readCookie(req, SESSION_COOKIE));
    if (!user) {
      const login = publicUrl("/login", req);
      login.searchParams.set("next", "/settings");
      return Response.redirect(login, 303);
    }
    state += `|connect:${user.id}`;
  }
  const redirectUri = publicUrl("/api/auth/github/callback", req).toString();

  const res = new Response(null, {
    status: 303,
    headers: { Location: authorizeUrl(nonce, redirectUri) },
  });
  // The state round trip: GitHub hands the nonce back, and only this browser
  // holds the cookie that matches it.
  res.headers.append(
    "Set-Cookie",
    cookieHeader(OAUTH_COOKIE, encodeURIComponent(await signValue(state)), 600),
  );
  return res;
}
