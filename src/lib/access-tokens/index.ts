import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { repository } from "@/lib/db";
import type { AccessTokenRecord, UserRecord } from "@/lib/db/repository";

export const TOKEN_PREFIX = "fmc_";

/** What a token shows about itself: never the secret or its hash. */
export type AccessTokenSummary = Omit<AccessTokenRecord, "userId" | "tokenHash" | "projectId" | "sessionId">;

/** What a PM token is limited to: one board, for one session. */
export interface TokenScope {
  projectId: string;
  sessionId: string;
}

/** How long a PM token lives unless asked for less: one session's work, not a standing key. */
export const PM_TOKEN_HOURS = 4;
/** The most a PM token may live, whatever is asked. */
export const PM_TOKEN_MAX_HOURS = 12;

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

/** Makes a token. The plaintext secret is returned here and nowhere else. */
export async function createToken(
  userId: string,
  input: { name: string; readOnly: boolean; expiresAt?: Date | null },
): Promise<{ id: string; secret: string }> {
  const secret = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const record = await repository().createAccessToken({
    userId,
    name: input.name,
    tokenHash: hashSecret(secret),
    lastFour: secret.slice(-4),
    readOnly: input.readOnly,
    expiresAt: input.expiresAt ?? null,
  });
  return { id: record.id, secret };
}

/**
 * A token for the board's PM session: it acts as `userId`, but only on this
 * board, only with the PM's tools, and only for a few hours. The session
 * revokes it when it ends. The plaintext secret is returned here and nowhere else.
 */
export async function createPmToken(
  userId: string,
  scope: TokenScope,
  hours = PM_TOKEN_HOURS,
): Promise<{ id: string; secret: string; expiresAt: Date }> {
  if (!scope.projectId || !scope.sessionId) throw new Error("A PM token needs a board and a session.");
  if (!(await repository().projectById(scope.projectId))) throw new Error("That board does not exist.");
  const life = Math.min(Math.max(hours, 0), PM_TOKEN_MAX_HOURS) * 3_600_000;
  const expiresAt = new Date(Date.now() + life);
  const secret = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const record = await repository().createAccessToken({
    userId,
    name: "PM session",
    tokenHash: hashSecret(secret),
    lastFour: secret.slice(-4),
    readOnly: false,
    expiresAt,
    projectId: scope.projectId,
    sessionId: scope.sessionId,
  });
  return { id: record.id, secret, expiresAt };
}

/** Ends a PM session's access: its tokens, or every PM token on the board without a session. */
export function revokePmTokens(projectId: string, sessionId?: string): Promise<number> {
  return repository().revokeBoardTokens(projectId, sessionId);
}

export interface VerifiedToken {
  user: UserRecord;
  readOnly: boolean;
  /** Set for a PM token: the one board and session it may act on. Null for a person's own token. */
  scope: TokenScope | null;
}

/** The owner, mode and scope of a live token, or null when it is unknown, revoked or expired. */
export async function verifyToken(secret: string): Promise<VerifiedToken | null> {
  const repo = repository();
  const token = await repo.accessTokenByHash(hashSecret(secret));
  if (!token || token.revokedAt) return null;
  const now = new Date();
  if (token.expiresAt && token.expiresAt <= now) return null;
  const user = await repo.userById(token.userId);
  if (!user) return null;
  // A board token always carries its session: one without is never honoured.
  if (token.projectId && !token.sessionId) return null;
  await repo.touchAccessToken(token.id, now);
  const scope = token.projectId ? { projectId: token.projectId, sessionId: token.sessionId! } : null;
  return { user, readOnly: token.readOnly, scope };
}

/** A person's own tokens. PM session tokens come and go with sessions and are not listed. */
export async function listTokens(userId: string): Promise<AccessTokenSummary[]> {
  const tokens = (await repository().accessTokensForUser(userId)).filter((t) => !t.projectId);
  return tokens.map(({ id, name, lastFour, readOnly, expiresAt, revokedAt, createdAt, lastUsedAt }) => ({
    id,
    name,
    lastFour,
    readOnly,
    expiresAt,
    revokedAt,
    createdAt,
    lastUsedAt,
  }));
}

/** Revokes one of the person's own tokens; false when it is not theirs or is already revoked. */
export function revokeToken(userId: string, id: string): Promise<boolean> {
  return repository().revokeAccessToken(userId, id);
}
