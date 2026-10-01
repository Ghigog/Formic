-- AlterTable
ALTER TABLE "user" ADD COLUMN     "tokenLimit" JSONB,
ADD COLUMN     "attemptLimit" JSONB;

-- AlterTable
ALTER TABLE "agent_preset" ADD COLUMN     "tokenAllowance" INTEGER,
ADD COLUMN     "tokenAllowanceWindowDays" INTEGER;

-- AlterTable
ALTER TABLE "column_agent" ADD COLUMN     "overrideMinutes" INTEGER,
ADD COLUMN     "overrideTokens" INTEGER,
ADD COLUMN     "overrideAttempts" INTEGER;
