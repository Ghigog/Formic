import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { isGitlabLinked, revokeGitlabToken } from "@/lib/auth/gitlab";
import { open } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

/**
 * Disconnects GitLab from this person's account: revokes the token at
 * GitLab now, then forgets the account and its tokens. Their boards stay;
 * agents on a GitLab board stop until GitLab is connected again.
 */
export async function DELETE() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!isGitlabLinked(user)) return Response.json({ ok: true });
  const token = user.gitlabTokenCipher ? open(user.gitlabTokenCipher) : null;
  if (token) await revokeGitlabToken(token);
  await repository().unlinkGitlab(user.id);
  return Response.json({ ok: true });
}
