import { currentUser } from "@/lib/auth/user";
import { credentialsFor } from "@/lib/auth/credentials";
import { installUrl } from "@/lib/auth/github";
import { authMode } from "@/lib/auth/session";
import { listRepositories } from "@/lib/vcs/repositories";

export const dynamic = "force-dynamic";

/** What the repository picker offers this person, and where to grant more. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const install = installUrl();
  const { githubToken, githubTokenKind } = await credentialsFor(user);
  if (!githubToken || !githubTokenKind) {
    return Response.json({
      ok: false,
      reason:
        authMode() === "github"
          ? "Your GitHub sign-in has lapsed. Sign out and back in."
          : "Set GITHUB_TOKEN to list your repositories. You can still type owner/repo.",
      installUrl: install,
    });
  }

  const result = await listRepositories(githubToken, githubTokenKind);
  return Response.json({ ...result, installUrl: install });
}
