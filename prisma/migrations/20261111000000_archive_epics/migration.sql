-- AlterTable
ALTER TABLE "epic" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ticket" ADD COLUMN "archivedWithEpic" BOOLEAN NOT NULL DEFAULT false;
