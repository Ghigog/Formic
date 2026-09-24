import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  authMode,
  gatePassword,
  passwordToken,
  safeEqual,
  verifySession,
} from "@/lib/auth/session";

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

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (OPEN.some((re) => re.test(path))) return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  let allowed: boolean;
  if (authMode() === "github") {
    allowed = (await verifySession(cookie)) !== null;
  } else {
    const password = gatePassword();
    allowed = !password || (!!cookie && safeEqual(cookie, await passwordToken(password)));
  }
  if (allowed) return NextResponse.next();

  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }
  const login = new URL("/login", req.url);
  login.searchParams.set("next", path + req.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
