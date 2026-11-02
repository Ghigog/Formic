-- Boards brought in with an established codebase can unlock every Sentinel
-- without earning colony XP first. Off until the owner opts in.
ALTER TABLE "project" ADD COLUMN "unlockAllSentinels" BOOLEAN NOT NULL DEFAULT false;
