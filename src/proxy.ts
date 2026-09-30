import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  authMode,
  gatePassword,
  passwordToken,
  safeEqual,
} from "@/lib/auth/session";
import { needsTermsAcceptance, userForSession } from "@/lib/auth/user";
import type { UserRecord } from "@/lib/db/repository";

/**
 * Nothing on the board without signing in. With a GitHub App configured
 * that means a GitHub session; without one, FORMIC_PASSWORD if it is set.
 *
 * Open regardless: sign-in itself, health checks, the GitHub webhook, which
 * authenticates with its own signature, and a runner's report and bundle,
 * which carry a token good for one job.
 */

const OPEN = [
  /^\/login$/,
  /^\/api\/login$/,
  /^\/api\/auth\//,
  /^\/api\/health$/,
  /^\/api\/webhooks\//,
  /^\/api\/runner\/report$/,
  /^\/api\/runner\/bundle$/,
];

/** Exempt from the terms gate below, so accepting them isn't itself gated on accepting them. */
const LEGAL = /^\/legal(\/|$)/;

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (OPEN.some((re) => re.test(path))) return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  let user: UserRecord | null = null;
  let allowed: boolean;
  if (authMode() === "github") {
    user = await userForSession(cookie);
    allowed = user !== null;
  } else {
    const password = gatePassword();
    allowed = !password || (!!cookie && safeEqual(cookie, await passwordToken(password)));
  }
  if (!allowed) {
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "Sign in first." }, { status: 401 });
    }
    const login = new URL("/login", req.url);
    login.searchParams.set("next", path + req.nextUrl.search);
    return NextResponse.redirect(login);
  }

  // GitHub accounts are real people who can be asked to agree to something;
  // local mode's one implicit user has no sign-in flow to hang this off.
  if (user && !LEGAL.test(path)) {
    if (needsTermsAcceptance(user)) {
      if (path.startsWith("/api/")) {
        return NextResponse.json({ error: "Accept the current terms first." }, { status: 403 });
      }
      const legal = new URL("/legal", req.url);
      legal.searchParams.set("next", path + req.nextUrl.search);
      return NextResponse.redirect(legal);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
