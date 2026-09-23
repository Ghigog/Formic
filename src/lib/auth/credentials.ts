import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { env } from "@/lib/secrets/env";
import { open } from "@/lib/secrets/vault";
import { githubTokenFor } from "./github";
import { authMode } from "./session";

/**
 * Whose keys a piece of work runs on.
 *
 * Signed in with GitHub, GitHub access is always the person's own token and
 * never the server's: falling back to a server token would let anyone who
 * can sign in act with the operator's access. E2B falls back to the server's
 * key when set, which is the operator choosing to pay for sandboxes.
 *
 * AI provider keys are not here: each agent template carries its own.
 *
 * In local mode there is one person and the server's keys are theirs.
 */
export interface Credentials {
  githubToken: string | null;
  /** An app user token lists repositories through its installations. */
  githubTokenKind: "app" | "pat" | null;
  e2bKey: string | null;
}

export async function credentialsFor(user: UserRecord | null): Promise<Credentials> {
  const config = env();
  const own = (cipher: string | null | undefined) => (cipher ? open(cipher) : null);

  if (authMode() === "github" && user && user.githubId !== 0) {
    const githubToken = await githubTokenFor(user);
    return {
      githubToken,
      githubTokenKind: githubToken ? "app" : null,
      e2bKey: own(user.e2bKeyCipher) ?? config.E2B_API_KEY ?? null,
    };
  }

  return {
    githubToken: config.GITHUB_TOKEN ?? null,
    githubTokenKind: config.GITHUB_TOKEN ? "pat" : null,
    e2bKey: own(user?.e2bKeyCipher) ?? config.E2B_API_KEY ?? null,
  };
}

/** The credentials of whoever owns a project. Runs happen on their behalf. */
export async function credentialsForProject(project: ProjectSummary): Promise<Credentials> {
  const owner = project.ownerId ? await repository().userById(project.ownerId) : null;
  return credentialsFor(owner);
}
