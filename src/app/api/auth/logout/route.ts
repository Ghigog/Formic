import { SESSION_COOKIE, cookieHeader } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const res = new Response(null, {
    status: 303,
    headers: { Location: new URL("/login", req.url).toString() },
  });
  res.headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", 0));
  return res;
}
