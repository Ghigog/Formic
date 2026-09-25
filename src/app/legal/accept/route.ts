import { CURRENT_TERMS_VERSION, currentUser } from "@/lib/auth/user";
import { repository } from "@/lib/db";
import { safeNext } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Records acceptance of the current terms for whoever is signed in. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }

  const form = await req.formData();
  const next = safeNext(String(form.get("next") ?? ""));
  await repository().acceptTerms(user.id, CURRENT_TERMS_VERSION);

  return new Response(null, { status: 303, headers: { Location: new URL(next, req.url).toString() } });
}
