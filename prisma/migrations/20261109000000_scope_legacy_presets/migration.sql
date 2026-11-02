-- Agents still unscoped (column NULL) showed in every column's picker. Every
-- agent now belongs to one place: one board column, or the PM (NULL).

-- Done has no agent of its own any more: it runs on the PM. Agents scoped to
-- Done were PM agents, and the PM's picker only offers unscoped ones.
UPDATE "agent_preset" SET "column" = NULL WHERE "column" = 'done';

-- An unscoped agent already running exactly one kind of column, and never
-- the PM, belongs to that column.
WITH used AS (
  SELECT "presetId", "column"::text AS slot FROM "column_agent"
  UNION
  SELECT "presetId", "slot" FROM "member_agent"
  UNION
  SELECT "assistantPresetId", 'assistant' FROM "project" WHERE "assistantPresetId" IS NOT NULL
),
single AS (
  SELECT "presetId", MIN(slot) AS slot FROM used GROUP BY "presetId" HAVING COUNT(DISTINCT slot) = 1
)
UPDATE "agent_preset" p SET "column" = single.slot::"ColumnId"
FROM single
WHERE p."id" = single."presetId" AND p."column" IS NULL
  AND single.slot IN ('backlog', 'todo', 'in_progress', 'in_review');

-- The rest, by the role in their name, unless they are a PM somewhere.
WITH pm AS (
  SELECT "assistantPresetId" AS id FROM "project" WHERE "assistantPresetId" IS NOT NULL
  UNION
  SELECT "presetId" FROM "member_agent" WHERE "slot" = 'assistant'
)
UPDATE "agent_preset" SET "column" = CASE
    WHEN "name" ILIKE '%review%' THEN 'in_review'::"ColumnId"
    WHEN "name" ILIKE '%coder%' OR "name" ILIKE '%code%' OR "name" ILIKE '%worker%' OR "name" ILIKE '%build%' THEN 'in_progress'::"ColumnId"
    WHEN "name" ILIKE '%architect%' THEN 'todo'::"ColumnId"
    WHEN "name" ILIKE '%product%' THEN 'backlog'::"ColumnId"
  END
WHERE "column" IS NULL
  AND "id" NOT IN (SELECT id FROM pm)
  AND ("name" ILIKE '%review%' OR "name" ILIKE '%coder%' OR "name" ILIKE '%code%' OR "name" ILIKE '%worker%'
       OR "name" ILIKE '%build%' OR "name" ILIKE '%architect%' OR "name" ILIKE '%product%');
