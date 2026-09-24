import { z } from "zod";
import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { revokeToken } from "@/lib/auth/github";
import { SESSION_COOKIE, cookieHeader } from "@/lib/auth/session";
import { open } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

/** Requires an explicit confirm, so a stray or scripted call cannot delete anyone. */
const bodySchema = z.object({ confirm: z.literal(true) });

/**
 * Deletes this person's account: revokes their GitHub token, then removes
 * their rows and everything that cascades from them (boards, presets, keys,
 * events, messages). Does not touch GitHub itself — see docs/legal/privacy.md
 * for what stays behind there and how to remove it.
 */
export async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "Confirm the deletion first." }, { status: 400 });
  }

  const token = user.githubTokenCipher ? open(user.githubTokenCipher) : null;
  if (token) await revokeToken(token);
  await repository().deleteUser(user.id);

  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", cookieHeader(SESSION_COOKIE, "", 0));
  return res;
}
