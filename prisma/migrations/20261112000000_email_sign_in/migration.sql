-- Email sign-in. Expand only: preview deploys share this database, so code
-- from before this migration must keep working against it.

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "githubId" DROP NOT NULL,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "login_token" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "next" TEXT NOT NULL DEFAULT '/',
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "login_token_tokenHash_key" ON "login_token"("tokenHash");

-- CreateIndex
CREATE INDEX "login_token_email_createdAt_idx" ON "login_token"("email", "createdAt");

-- CreateIndex
CREATE INDEX "login_token_ip_createdAt_idx" ON "login_token"("ip", "createdAt");
