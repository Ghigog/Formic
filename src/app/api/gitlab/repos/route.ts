import { currentUser } from "@/lib/auth/user";
import { credentialsFor } from "@/lib/auth/credentials";
import { gitlabConfig, isGitlabLinked } from "@/lib/auth/gitlab";
import { authMode } from "@/lib/auth/session";
import { env } from "@/lib/secrets/env";
import { listGitlabProjects } from "@/lib/vcs/gitlab-repositories";

export const dynamic = "force-dynamic";

/**
 * The gitlab.com projects the picker offers this person. `configured: false`
 * when this Formic has no GitLab application (and, in local mode, no
 * GITLAB_TOKEN): the picker then shows no GitLab section at all.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const accounts = authMode() === "accounts";
  if (accounts ? !gitlabConfig() : !env().GITLAB_TOKEN) {
    return Response.json({ configured: false, ok: false, repos: [] });
  }
  if (accounts && !isGitlabLinked(user)) {
    return Response.json({
      configured: true,
      ok: false,
      reason: "Connect GitLab to list your projects.",
      connectUrl: "/api/auth/gitlab/login",
      repos: [],
    });
  }
  const { gitlabToken } = await credentialsFor(user, "gitlab");
  if (!gitlabToken) {
    return Response.json({
      configured: true,
      ok: false,
      reason: "Your GitLab connection has lapsed. Connect GitLab again.",
      connectUrl: accounts ? "/api/auth/gitlab/login" : null,
      repos: [],
    });
  }
  const result = await listGitlabProjects(gitlabToken);
  return Response.json({ configured: true, ...result, repos: result.ok ? result.repos : [] });
}
