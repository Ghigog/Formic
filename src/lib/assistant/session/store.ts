import "server-only";

import { repository } from "@/lib/db";
import type { PmSessionRecord, PmSessionWhere } from "@/lib/db/repository";
import { open, seal } from "@/lib/secrets/vault";
import { revokePmTokens } from "@/lib/access-tokens";

/**
 * The board's PM session file, at rest (docs/plans/pm-chat.md, safety row
 * 6): sealed with the API-key cipher, the latest only, and refused above a
 * cap, so a session that grew too big starts again from the summary instead
 * of slowing every turn.
 */

/** The most a session file may be, gzipped. A bigger one is dropped and the next turn starts fresh. */
export const PM_SESSION_MAX_BYTES = 8 * 1024 * 1024;

/** A session file as the job hands it over: gzipped JSONL, base64. */
export type PackedFile = string;

/** The gzipped size of a packed file. */
export function packedBytes(file: PackedFile): number {
  return Buffer.from(file, "base64").length;
}

/**
 * Seals a session file for the database. Null when it is empty or over the
 * cap: the session then starts fresh from its summary.
 */
export function sealFile(file: PackedFile): { cipher: string; bytes: number } | null {
  const clean = file.trim();
  if (!clean || !/^[A-Za-z0-9+/=]+$/.test(clean)) return null;
  const bytes = packedBytes(clean);
  if (bytes === 0 || bytes > PM_SESSION_MAX_BYTES) return null;
  return { cipher: seal(clean), bytes };
}

/** The packed session file, or null when there is none or it no longer opens (the secret changed). */
export function openFile(session: Pick<PmSessionRecord, "fileCipher">): PackedFile | null {
  return session.fileCipher ? open(session.fileCipher) : null;
}

/** Where a board's session runs when it has no E2B key: its repository's CI. */
export function ciWhere(repoFullName: string | null | undefined): PmSessionWhere {
  return repoFullName?.startsWith("gitlab:") ? "gitlab" : "actions";
}

/**
 * Ends the board's session: its tokens revoked and its row, file and summary
 * gone. Clear calls this, so the next message starts a fresh session.
 */
export async function endPmSession(projectId: string): Promise<void> {
  const session = await repository().pmSession(projectId);
  await revokePmTokens(projectId, session?.sessionId);
  await repository().deletePmSession(projectId);
}
