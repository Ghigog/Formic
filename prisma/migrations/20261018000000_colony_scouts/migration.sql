-- The colony: a cap on Coder Agents running at once, a reserve kept for
-- urgent work, and scouts, several attempts at one ticket of which one is
-- kept (docs/colony.md). Every column is off or empty by default.
ALTER TABLE "project" ADD COLUMN "colonySize" INTEGER;
ALTER TABLE "project" ADD COLUMN "colonyReserve" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "project" ADD COLUMN "autoScout" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ticket" ADD COLUMN "scoutOf" TEXT;
ALTER TABLE "ticket" ADD COLUMN "scoutBrief" TEXT;
ALTER TABLE "ticket" ADD COLUMN "scoutPresetId" TEXT;
ALTER TABLE "ticket" ADD COLUMN "scouts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ticket" ADD COLUMN "scoutPick" TEXT;
ALTER TABLE "ticket" ADD COLUMN "scoutWhy" TEXT;
CREATE INDEX "ticket_scoutOf_idx" ON "ticket"("scoutOf");
