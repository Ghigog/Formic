-- AlterTable
ALTER TABLE "attachment" ADD COLUMN     "assistantMessageId" TEXT;

-- CreateIndex
CREATE INDEX "attachment_assistantMessageId_idx" ON "attachment"("assistantMessageId");
