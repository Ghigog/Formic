import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { repository } from "@/lib/db";
import type { AccessTokenRecord, UserRecord } from "@/lib/db/repository";

export const TOKEN_PREFIX = "fmc_";

/** What a token shows about itself: never the secret or its hash. */
export type AccessTokenSummary = Omit<AccessTokenRecord, "userId" | "tokenHash">;

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

/** The owner and mode of a live token, or null when it is unknown, revoked or expired. */
export async function verifyToken(secret: string): Promise<{ user: UserRecord; readOnly: boolean } | null> {
  const repo = repository();
  const token = await repo.accessTokenByHash(hashSecret(secret));
  if (!token || token.revokedAt) return null;
  const now = new Date();
  if (token.expiresAt && token.expiresAt <= now) return null;
  const user = await repo.userById(token.userId);
  if (!user) return null;
  await repo.touchAccessToken(token.id, now);
  return { user, readOnly: token.readOnly };
}

export async function listTokens(userId: string): Promise<AccessTokenSummary[]> {
  const tokens = await repository().accessTokensForUser(userId);
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
