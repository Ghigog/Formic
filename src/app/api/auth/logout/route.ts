import { SESSION_COOKIE, cookieHeader } from "@/lib/auth/session";
import { userForSession } from "@/lib/auth/user";
import { repository } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Signs out everywhere: bumping the version ends every cookie issued before, including copies. */
export async function POST(req: Request) {
  const cookie = req.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const user = await userForSession(cookie);
  if (user) await repository().bumpSessionVersion(user.id);

  const res = new Response(null, {
    status: 303,
    headers: { Location: new URL("/login", req.url).toString() },
  });
  res.headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", 0));
  return res;
}
