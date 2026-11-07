-- A gitlab.com account connected to a Formic user: its id, handle and sealed OAuth tokens.
ALTER TABLE "user" ADD COLUMN "gitlabId" INTEGER,
ADD COLUMN "gitlabLogin" TEXT,
ADD COLUMN "gitlabTokenCipher" TEXT,
ADD COLUMN "gitlabTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "gitlabRefreshCipher" TEXT;

CREATE UNIQUE INDEX "user_gitlabId_key" ON "user"("gitlabId");
