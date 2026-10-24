-- Agents are a per-board setting, and a board needs no repository without them.
-- Boards that exist now keep working with agents; new ones start with them off.
ALTER TABLE "project" ADD COLUMN "agents" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "project" ALTER COLUMN "agents" SET DEFAULT false;
ALTER TABLE "project" ALTER COLUMN "repoFullName" DROP NOT NULL;
