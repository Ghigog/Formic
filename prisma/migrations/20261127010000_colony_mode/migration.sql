-- The colony cap is Automatic by default. A board with a number keeps it as manual.
ALTER TABLE "project" ADD COLUMN "colonyMode" TEXT NOT NULL DEFAULT 'auto';
UPDATE "project" SET "colonyMode" = 'manual' WHERE "colonySize" IS NOT NULL;
