-- A board can have agents switched off, so a person drives it with their own coding agent.
ALTER TABLE "project" ADD COLUMN "agentsOff" BOOLEAN NOT NULL DEFAULT false;
