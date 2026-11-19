import "server-only";

import { repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { authMode } from "@/lib/auth/session";
import { credentialsFor } from "@/lib/auth/credentials";
import { open } from "@/lib/secrets/vault";
import { PLAYTEST_LEVEL, scoreOf } from "@/lib/colony/game";
import { columnFor } from "@/lib/domain/status";
import { repoHost } from "@/lib/vcs/host";

/**
 * Who may start a playtest, and on which keys. The rules from the risk
 * assessment (docs/plans/playtest.md, "Rules"):
 *
 * - The clicker's own E2B key, never the owner's shared one and never the
 *   server's. In local mode the server's key is the one person's own.
 * - Their own token for the repository's host.
 * - Something merged: a ticket in Done.
 * - The board at Playtest's level.
 */

export type PlaytestBlock = "locked" | "no-key" | "no-repo" | "no-repo-access" | "nothing-merged";

export type PlaytestAccess =
  | { ok: true; e2bKey: string; repoToken: string }
  | { ok: false; reason: PlaytestBlock; message: string };

export const BLOCK_MESSAGES: Record<PlaytestBlock, string> = {
  locked: `Playtest unlocks at Lv ${PLAYTEST_LEVEL}.`,
  "no-key": "Playtest runs in an E2B sandbox on your own key. Add it in Settings.",
  "no-repo": "This board has no repository to play.",
  "no-repo-access": "Playtest clones with your own access to the repository, and you have none. Connect it in Settings.",
  "nothing-merged": "Nothing shipped yet. Playtest opens once a ticket has merged.",
};

function blocked(reason: PlaytestBlock): PlaytestAccess {
  return { ok: false, reason, message: BLOCK_MESSAGES[reason] };
}

/** The person's own E2B key, and only theirs. */
export function ownE2bKey(user: UserRecord | null): string | null {
  const own = user?.e2bKeyCipher ? open(user.e2bKeyCipher) : null;
  if (own) return own;
  return authMode() === "local" ? (process.env.E2B_API_KEY?.trim() || null) : null;
}

export async function playtestAccess(project: ProjectSummary, user: UserRecord | null): Promise<PlaytestAccess> {
  const cards = await repository().boardCards(project.id);
  // "Unlock everything" in Settings (stored as unlockAllSentinels) opens Playtest early too.
  if (!project.unlockAllSentinels && scoreOf(cards).level < PLAYTEST_LEVEL) return blocked("locked");
  const e2bKey = ownE2bKey(user);
  if (!e2bKey) return blocked("no-key");
  if (!project.repoFullName) return blocked("no-repo");
  const merged = cards.some((c) => c.kind === "ticket" && columnFor(c.status, c.stalledIn) === "done" && !!c.mergedAt);
  if (!merged) return blocked("nothing-merged");
  // The clicker's own token, not the owner's: Playtest acts as whoever pressed it.
  const creds = await credentialsFor(user, repoHost(project.repoFullName));
  if (!creds.repoToken) return blocked("no-repo-access");
  return { ok: true, e2bKey, repoToken: creds.repoToken };
}
