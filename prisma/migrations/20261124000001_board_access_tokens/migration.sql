-- AlterTable
ALTER TABLE "access_token" ADD COLUMN "projectId" TEXT,
ADD COLUMN "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "access_token_projectId_sessionId_idx" ON "access_token"("projectId", "sessionId");

-- AddForeignKey
ALTER TABLE "access_token" ADD CONSTRAINT "access_token_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
