-- AlterTable
ALTER TABLE "assistant_message" ADD COLUMN "agentPresetId" TEXT,
ADD COLUMN "tokensIn" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tokensOut" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "assistant_message_agentPresetId_createdAt_idx" ON "assistant_message"("agentPresetId", "createdAt");

-- AlterTable
ALTER TABLE "pm_session" ADD COLUMN "contextTokens" INTEGER NOT NULL DEFAULT 0;
