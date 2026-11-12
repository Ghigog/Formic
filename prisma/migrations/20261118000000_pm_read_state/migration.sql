-- AlterTable
ALTER TABLE "project_open" ADD COLUMN "pmReadAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "assistant_message" ADD COLUMN "cards" JSONB;
