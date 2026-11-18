-- CreateTable
CREATE TABLE "rubric_fix" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sentinel" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "ticketId" TEXT,
    "ticketKey" TEXT,
    "flaggedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'flagged',
    "messageId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rubric_fix_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rubric_fix_projectId_sentinel_idx" ON "rubric_fix"("projectId", "sentinel");

-- AddForeignKey
ALTER TABLE "rubric_fix" ADD CONSTRAINT "rubric_fix_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
