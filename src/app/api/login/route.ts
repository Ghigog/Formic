import { SESSION_COOKIE, gatePassword, safeEqual, sessionToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Form post from /login. Sets the session cookie and sends you on. */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const given = String(form?.get("password") ?? "");
  const rawNext = String(form?.get("next") ?? "/");
  // Only same-site paths, so the login cannot bounce someone elsewhere.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const password = gatePassword();
  if (!password) return Response.redirect(new URL(next, req.url), 303);

  const expected = await sessionToken(password);
  if (!safeEqual(await sessionToken(given), expected)) {
    const back = new URL("/login", req.url);
    back.searchParams.set("next", next);
    back.searchParams.set("error", "1");
    return Response.redirect(back, 303);
  }

  const res = new Response(null, { status: 303, headers: { Location: next } });
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${expected}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
  return res;
}
