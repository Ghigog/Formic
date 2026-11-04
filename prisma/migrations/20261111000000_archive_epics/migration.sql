-- AlterTable
ALTER TABLE "Epic" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "archivedWithEpic" BOOLEAN NOT NULL DEFAULT false;
