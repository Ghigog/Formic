import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

/** Starts this person's token count again from now, for plans with no renewal day. */
export async function POST() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const updated = await repository().stampTokenReset(user.id, new Date());
  return Response.json({ resetAt: updated.tokenResetAt?.toISOString() ?? null });
}
