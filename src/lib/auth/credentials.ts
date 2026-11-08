import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { env } from "@/lib/secrets/env";
import { open } from "@/lib/secrets/vault";
import { githubTokenFor, isGithubLinked } from "./github";
import { gitlabTokenFor, isGitlabLinked } from "./gitlab";
import { repoHost, type RepoHost } from "@/lib/vcs/host";
import { authMode } from "./session";
import { actingUserId } from "./actor";

/**
 * Whose keys a piece of work runs on.
 *
 * With accounts, GitHub access is always the person's own token and never
 * the server's, and someone who has not connected GitHub has none: falling back to a server token would let anyone who
 * can sign in act with the operator's access. E2B falls back to the server's
 * key when set, which is the operator choosing to pay for sandboxes.
 *
 * AI provider keys are not here: each agent template carries its own.
 *
 * In local mode there is one person and the server's keys are theirs.
 */
export interface Credentials {
  githubToken: string | null;
  /** The person's gitlab.com token, looked up only for work on a GitLab project. */
  gitlabToken: string | null;
  /**
   * The token for the project's own host: what `vcs()` acts with. GitHub's
   * for a GitHub repository, GitLab's for a GitLab one.
   */
  repoToken: string | null;
  /** An app user token lists repositories through its installations. */
  githubTokenKind: "app" | "pat" | null;
  e2bKey: string | null;
  /** Set when e2bKey is the operator's: the person whose sandbox minutes are capped. */
  e2bFallbackUserId: string | null;
}

export async function credentialsFor(user: UserRecord | null, host: RepoHost = "github"): Promise<Credentials> {
  const config = env();
  const e2bCredentials = (u: UserRecord | null) => {
    const own = u?.e2bKeyCipher ? open(u.e2bKeyCipher) : null;
    if (own) return { e2bKey: own, e2bFallbackUserId: null };
    return {
      e2bKey: config.E2B_API_KEY ?? null,
      e2bFallbackUserId: config.E2B_API_KEY && u ? u.id : null,
    };
  };

  // With accounts, GitHub is only ever the person's own. Someone who signed in
  // by email and never connected GitHub has none: never the server's token.
  if (authMode() === "accounts") {
    const githubToken = user && isGithubLinked(user) ? await githubTokenFor(user) : null;
    const gitlabToken = host === "gitlab" && user && isGitlabLinked(user) ? await gitlabTokenFor(user) : null;
    return {
      githubToken,
      githubTokenKind: githubToken ? "app" : null,
      gitlabToken,
      repoToken: host === "gitlab" ? gitlabToken : githubToken,
      ...e2bCredentials(user),
    };
  }

  const githubToken = config.GITHUB_TOKEN ?? null;
  const gitlabToken = host === "gitlab" ? (config.GITLAB_TOKEN ?? null) : null;
  return {
    githubToken,
    githubTokenKind: githubToken ? "pat" : null,
    gitlabToken,
    repoToken: host === "gitlab" ? gitlabToken : githubToken,
    ...e2bCredentials(user),
  };
}

/**
 * The credentials work on a project runs on: the owner's, or, on a shared
 * board, the member's own whose work it is (./actor.ts). A member with no E2B
 * key of their own falls back to the owner's only when the owner shares keys.
 */
export async function credentialsForProject(project: ProjectSummary): Promise<Credentials> {
  const repo = repository();
  const owner = project.ownerId ? await repo.userById(project.ownerId) : null;
  const host = repoHost(project.repoFullName);
  const actorId = actingUserId();
  if (!actorId || actorId === project.ownerId || authMode() !== "accounts") return credentialsFor(owner, host);
  const member = await repo.userById(actorId);
  if (!member) return credentialsFor(owner, host);
  const own = await credentialsFor(member, host);
  if (own.e2bKey || !project.shareKeys) return own;
  const shared = await credentialsFor(owner, host);
  return { ...own, e2bKey: shared.e2bKey, e2bFallbackUserId: shared.e2bFallbackUserId };
}
