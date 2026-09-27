-- Every preset used to show in every column's picker. Presets are now
-- permanently scoped to the column they were made for; a preset scoped to
-- one column no longer appears in another's picker. Existing presets have
-- no such column yet, so this backfills it from their name using the same
-- role vocabulary the columns already label themselves with
-- (COLUMN_AGENT_ROLE / AGENT_ROLE_LABELS). Anything whose name matches none
-- of those stays NULL: unscoped, shown in every column, exactly as before.
ALTER TABLE "agent_preset" ADD COLUMN "column" "ColumnId";

UPDATE "agent_preset" SET "column" = 'in_review' WHERE "column" IS NULL AND "name" ILIKE '%review%';
UPDATE "agent_preset" SET "column" = 'in_progress' WHERE "column" IS NULL AND ("name" ILIKE '%coder%' OR "name" ILIKE '%code%');
UPDATE "agent_preset" SET "column" = 'todo' WHERE "column" IS NULL AND "name" ILIKE '%architect%';
UPDATE "agent_preset" SET "column" = 'backlog' WHERE "column" IS NULL AND "name" ILIKE '%product%';
UPDATE "agent_preset" SET "column" = 'done' WHERE "column" IS NULL AND ("name" ILIKE '%pm%' OR "name" ILIKE '%showcase%');
