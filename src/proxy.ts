import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, gatePassword, safeEqual, sessionToken } from "@/lib/auth/session";

/**
 * Everything behind FORMIC_PASSWORD when it is set. The board can start
 * agents on a saved API key and push to any repository the GitHub token
 * reaches, so a public deployment should not be usable by whoever finds it.
 *
 * Open regardless: the login itself, health checks, and the GitHub webhook,
 * which authenticates with its own signature.
 */

const OPEN = [/^\/login$/, /^\/api\/login$/, /^\/api\/health$/, /^\/api\/webhooks\//];

export async function proxy(req: NextRequest) {
  const password = gatePassword();
  if (!password) return NextResponse.next();

  const path = req.nextUrl.pathname;
  if (OPEN.some((re) => re.test(path))) return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookie && safeEqual(cookie, await sessionToken(password))) {
    return NextResponse.next();
  }

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
