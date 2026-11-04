import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { isGithubLinked, revokeToken } from "@/lib/auth/github";
import { open } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

/**
 * Disconnects GitHub from this person's account: revokes the token at GitHub
 * now, then forgets the GitHub id and every token. Their boards and cards
 * stay; agents on a board with a repository stop until GitHub is connected
 * again.
 *
 * Someone who has only ever signed in with GitHub has no other way back in,
 * so for them this is refused: deleting the account is the way out.
 */
export async function DELETE() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!isGithubLinked(user)) return Response.json({ ok: true });
  if (!user.email) {
    return Response.json(
      { error: "GitHub is how you sign in to Formic, so it can't be disconnected. Delete your account instead." },
      { status: 400 },
    );
  }

  const token = user.githubTokenCipher ? open(user.githubTokenCipher) : null;
  if (token) await revokeToken(token);
  await repository().unlinkGithub(user.id);
  return Response.json({ ok: true });
}
