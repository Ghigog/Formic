-- AlterTable
ALTER TABLE "assistant_message" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'pm';

-- Messages written before kinds existed: the person's own, and guests' replies.
UPDATE "assistant_message" SET "kind" = 'person' WHERE "role" = 'user';
UPDATE "assistant_message" SET "kind" = 'guest' WHERE "role" = 'assistant' AND "speaker" <> 'assistant';
