-- Agents off was a second switch for what "agents" already says. A board
-- someone switched off keeps agents off; then the column goes.
UPDATE "project" SET "agents" = false WHERE "agentsOff" = true;
ALTER TABLE "project" DROP COLUMN "agentsOff";
