-- The agent scouts run on, board-wide. Null runs them on the In Progress column's agent.
ALTER TABLE "project" ADD COLUMN "scoutPresetId" TEXT;
