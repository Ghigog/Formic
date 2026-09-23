import {
  SESSION_COOKIE,
  cookieHeader,
  gatePassword,
  passwordToken,
  safeEqual,
  safeNext,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Local mode's shared password, from /login. Sets the session cookie. */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const given = String(form?.get("password") ?? "");
  const next = safeNext(String(form?.get("next") ?? "/"));

  const password = gatePassword();
  if (!password) return Response.redirect(new URL(next, req.url), 303);

  const expected = await passwordToken(password);
  if (!safeEqual(await passwordToken(given), expected)) {
    const back = new URL("/login", req.url);
    back.searchParams.set("next", next);
    back.searchParams.set("error", "1");
    return Response.redirect(back, 303);
  }

  const res = new Response(null, { status: 303, headers: { Location: next } });
  res.headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, expected, 2592000));
  return res;
}
