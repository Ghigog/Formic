-- Sentinels: each auditor's latest report on a project, and its run in progress.
-- CreateTable
CREATE TABLE "audit" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sentinel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "log" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stars" INTEGER,
    "quote" TEXT,
    "summary" TEXT,
    "report" JSONB,
    "error" TEXT,
    "model" TEXT,
    "files" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_projectId_sentinel_idx" ON "audit"("projectId", "sentinel");

-- AddForeignKey
ALTER TABLE "audit" ADD CONSTRAINT "audit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
