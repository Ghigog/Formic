-- CreateTable
CREATE TABLE "pm_session" (
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "where" TEXT NOT NULL,
    "sandboxId" TEXT,
    "fileCipher" TEXT,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL DEFAULT '',
    "turnJob" TEXT,
    "handoff" TEXT,
    "branch" TEXT,
    "resumed" BOOLEAN NOT NULL DEFAULT false,
    "lastTurnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pm_session_pkey" PRIMARY KEY ("projectId")
);

-- AddForeignKey
ALTER TABLE "pm_session" ADD CONSTRAINT "pm_session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
