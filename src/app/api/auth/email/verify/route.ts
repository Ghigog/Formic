import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  cookieHeader,
  safeNext,
  secretProblem,
  signSession,
} from "@/lib/auth/session";
import { verifyEmailSignIn } from "@/lib/auth/email";
import { limit, limited } from "@/lib/rate-limit";
import { fromOwnPage } from "@/lib/origin";

export const dynamic = "force-dynamic";

const VERIFY = limit(20, 60_000);

/**
 * From /login/verify's button: spends the link and signs the person in. A
 * POST on purpose, so a mail scanner opening the link spends nothing.
 */
export async function POST(req: Request) {
  const refused = limited(req, VERIFY, "email-verify");
  if (refused) return refused;

  // Relative, as in ../start/route.ts: CSP form-action 'self' follows redirects.
  const fail = (error: string) =>
    new Response(null, { status: 303, headers: { Location: `/login?${new URLSearchParams({ error })}` } });

  // Signing someone in to an account of the sender's choosing is an attack too.
  if (!fromOwnPage(req)) return fail("Sign in from Formic's own page.");
  const problem = secretProblem();
  if (problem) return fail(problem);

  const form = await req.formData().catch(() => null);
  const result = await verifyEmailSignIn(form?.get("token"));
  if (!result.ok) return fail(result.error);

  const res = new Response(null, { status: 303, headers: { Location: safeNext(result.next) } });
  res.headers.append(
    "Set-Cookie",
    cookieHeader(SESSION_COOKIE, await signSession(result.user.id, Date.now(), result.user.sessionVersion), SESSION_MAX_AGE_S),
  );
  return res;
}
