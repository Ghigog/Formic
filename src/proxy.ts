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
import { countRequest, verdict } from "@/lib/usage/governor";

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

/**
 * Kept working while the host allowance is nearly spent ("heavy"): what
 * finishes work already started, and signing in and out. Only the health
 * check is answered once it is spent.
 */
const FINISHES_WORK = [
  /^\/api\/webhooks\//,
  /^\/api\/runner\/report$/,
  /^\/api\/runner\/bundle$/,
  /^\/api\/runs\/stop$/,
  /^\/api\/tickets\/[^/]+\/stop$/,
  /^\/api\/login$/,
  /^\/api\/auth\//,
];
const ALWAYS = /^\/api\/health$/;

/** Exempt from the terms gate below, so accepting them isn't itself gated on accepting them. */
const LEGAL = /^\/legal(\/|$)/;

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const refused = await overAllowance(req, path);
  if (refused) return refused;
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

/**
 * Refuses what would take the host past its allowance (src/lib/usage/governor.ts).
 * Near the line, work that starts more work: changes through the API and the
 * event stream. At it, everything but the health check, until the next UTC day.
 */
async function overAllowance(req: NextRequest, path: string): Promise<NextResponse | null> {
  if (ALWAYS.test(path)) return null;
  countRequest();
  const { standing, retryAfter } = await verdict();
  if (standing === "ok") return null;
  const heavy =
    path === "/api/events" ||
    (path.startsWith("/api/") && req.method !== "GET" && !FINISHES_WORK.some((re) => re.test(path)));
  if (standing === "heavy" && !heavy) return null;

  const message =
    standing === "stopped"
      ? "Formic has used its hosting allowance for now and is paused until 00:00 UTC."
      : "Formic is close to its hosting allowance, so new agent work is paused until 00:00 UTC. The board can still be read.";
  const headers = { "Retry-After": String(retryAfter), "Cache-Control": "no-store" };
  if (path.startsWith("/api/")) {
    return NextResponse.json({ error: message, allowance: standing }, { status: 503, headers });
  }
  return new NextResponse(message, {
    status: 503,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
