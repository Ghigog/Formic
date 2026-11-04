import { safeNext, secretProblem } from "@/lib/auth/session";
import { startEmailSignIn } from "@/lib/auth/email";
import { clientAddress, limit, limited } from "@/lib/rate-limit";
import { fromOwnPage, publicUrl } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** A burst guard in front of the per-address and per-IP counts the database keeps. */
const BURST = limit(10, 60_000);

/** From /login's email form: sends a sign-in link, then back to /login to say so. */
export async function POST(req: Request) {
  const refused = limited(req, BURST, "email-start");
  if (refused) return refused;

  const form = await req.formData().catch(() => null);
  const next = safeNext(String(form?.get("next") ?? "/"));
  const back = publicUrl("/login", req);
  back.searchParams.set("next", next);
  const fail = (error: string) => {
    back.searchParams.set("error", error);
    return Response.redirect(back, 303);
  };

  if (!fromOwnPage(req)) return fail("Sign in from Formic's own login page.");
  const problem = secretProblem();
  if (problem) return fail(problem);

  const result = await startEmailSignIn({
    email: form?.get("email"),
    next,
    ip: clientAddress(req),
    linkFor: (token) => {
      const link = publicUrl("/login/verify", req);
      link.searchParams.set("token", token);
      return link.toString();
    },
  }).catch((e) => {
    console.error("[formic] could not send a sign-in link:", e);
    return "failed" as const;
  });

  switch (result) {
    case "sent":
      back.searchParams.set("sent", "1");
      return Response.redirect(back, 303);
    case "invalid":
      return fail("That doesn't look like an email address.");
    case "limited":
      return fail("Too many sign-in links asked for. Wait a few minutes, then try again.");
    case "unavailable":
      return fail("Email sign-in isn't set up on this Formic.");
    case "failed":
      return fail("The sign-in email couldn't be sent. Try again in a minute.");
  }
}
