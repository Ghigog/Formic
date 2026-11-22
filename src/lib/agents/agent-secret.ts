import "server-only";

import { activeProject } from "@/lib/board/project";
import { credentialsFor } from "@/lib/auth/credentials";
import type { AgentPreset } from "@/lib/domain/entities";
import type { UserRecord } from "@/lib/db/repository";
import { provider as providerInfo, secretNameFor } from "@/lib/llm/providers";
import { vcs } from "@/lib/vcs";
import { repoHost } from "@/lib/vcs/host";

/**
 * A Claude Code token pasted once: Formic keeps it for the PM's sandbox
 * (docs/plans/pm-chat.md), and writes the same value into the secret the
 * agent's CI jobs sign in with, in the repository of the board the person
 * is on. Written with the person's own access, so they can only set a secret
 * on a repository they could set it on by hand.
 */
export type SecretOutcome = { saved: true; name: string; repo: string } | { saved: false; name: string; repo: string | null; reason: string };

export async function saveTokenToRepo(user: UserRecord, preset: Pick<AgentPreset, "id" | "provider" | "secretName">, token: string): Promise<SecretOutcome | null> {
  const info = providerInfo(preset.provider);
  if (info?.kind !== "cli" || info.cli !== "claude") return null;
  const name = secretNameFor({ presetId: preset.id, info, secretName: preset.secretName });
  const project = await activeProject();
  if (!project?.repoFullName) return { saved: false, name, repo: null, reason: "this board has no repository" };
  const repo = project.repoFullName;
  const creds = await credentialsFor(user, repoHost(repo));
  if (!creds.repoToken) return { saved: false, name, repo, reason: "your account is not connected to the repository's host" };
  try {
    await vcs(repo, creds.repoToken).saveAgentSecret(name, token);
    return { saved: true, name, repo };
  } catch (e) {
    return { saved: false, name, repo, reason: e instanceof Error ? e.message : String(e) };
  }
}
