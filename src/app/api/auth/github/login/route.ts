import { randomBytes } from "node:crypto";
import { authorizeUrl, appConfig } from "@/lib/auth/github";
import { OAUTH_COOKIE, cookieHeader, safeNext, signValue } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Starts sign-in: remembers where to come back to, then off to GitHub. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!appConfig()) return Response.redirect(new URL("/", url), 303);

  const nonce = randomBytes(16).toString("hex");
  const next = safeNext(url.searchParams.get("next"));
  const redirectUri = `${url.origin}/api/auth/github/callback`;

  const res = new Response(null, {
    status: 303,
    headers: { Location: authorizeUrl(nonce, redirectUri) },
  });
  // The state round trip: GitHub hands the nonce back, and only this browser
  // holds the cookie that matches it.
  res.headers.append(
    "Set-Cookie",
    cookieHeader(OAUTH_COOKIE, encodeURIComponent(await signValue(`${nonce}|${next}`)), 600),
  );
  return res;
}
