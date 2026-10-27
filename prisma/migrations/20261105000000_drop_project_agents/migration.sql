-- The board-wide agents switch is gone: each column's drop-down decides. A
-- board with agents on keeps its column agents. A board with agents off had
-- plain columns whatever they said, so they become "No agent" columns.
DELETE FROM "column_agent" WHERE "projectId" IN (SELECT "id" FROM "project" WHERE "agents" = false);
ALTER TABLE "project" DROP COLUMN "agents";
