-- AlterTable
ALTER TABLE "assistant_message" ADD COLUMN "playtestId" TEXT;

-- CreateTable
CREATE TABLE "playtest_session" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "commitSha" TEXT,
    "sandboxId" TEXT,
    "url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "stage" TEXT,
    "kind" TEXT,
    "logTail" TEXT,
    "error" TEXT,
    "endReason" TEXT,
    "summary" TEXT,
    "warned" BOOLEAN NOT NULL DEFAULT false,
    "nudgedSha" TEXT,
    "answeredAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "playtest_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_message_playtestId_idx" ON "assistant_message"("playtestId");

-- CreateIndex
CREATE INDEX "playtest_session_projectId_startedAt_idx" ON "playtest_session"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "playtest_session_userId_status_idx" ON "playtest_session"("userId", "status");

-- AddForeignKey
ALTER TABLE "playtest_session" ADD CONSTRAINT "playtest_session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playtest_session" ADD CONSTRAINT "playtest_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
