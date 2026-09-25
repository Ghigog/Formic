import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  authMode,
  gatePassword,
  passwordToken,
  safeEqual,
  verifySession,
} from "@/lib/auth/session";
import { needsTermsAcceptance } from "@/lib/auth/user";
import { repository } from "@/lib/db";

/**
 * Nothing on the board without signing in. With a GitHub App configured
 * that means a GitHub session; without one, FORMIC_PASSWORD if it is set.
 *
 * Open regardless: sign-in itself, health checks, the GitHub webhook, which
 * authenticates with its own signature, and a runner's report, which carries
 * a token good for its one job.
 */

const OPEN = [
  /^\/login$/,
  /^\/api\/login$/,
  /^\/api\/auth\//,
  /^\/api\/health$/,
  /^\/api\/webhooks\//,
  /^\/api\/runner\/report$/,
];

/** Exempt from the terms gate below, so accepting them isn't itself gated on accepting them. */
const LEGAL = /^\/legal(\/|$)/;

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (OPEN.some((re) => re.test(path))) return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  let userId: string | null = null;
  let allowed: boolean;
  if (authMode() === "github") {
    userId = await verifySession(cookie);
    allowed = userId !== null;
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
  if (userId && !LEGAL.test(path)) {
    const user = await repository().userById(userId);
    if (user && needsTermsAcceptance(user)) {
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
