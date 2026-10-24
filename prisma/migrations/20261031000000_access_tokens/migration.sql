-- Personal access tokens: only the sha256 of each secret is kept.
CREATE TABLE "access_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastFour" TEXT NOT NULL,
    "readOnly" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "access_token_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "access_token_tokenHash_key" ON "access_token"("tokenHash");
CREATE INDEX "access_token_userId_idx" ON "access_token"("userId");
ALTER TABLE "access_token" ADD CONSTRAINT "access_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
