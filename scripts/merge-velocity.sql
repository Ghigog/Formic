-- Merge velocity, for calibrating the timeline and the yield grades (EPIC-151).
--
-- One SELECT and nothing else, so it cannot change anything. Paste it into
-- your database's SQL editor (Supabase or Neon) and run it, or:
--
--   psql "$DATABASE_URL" -f scripts/merge-velocity.sql
--
-- It returns one small table of numbers. Copy that table back to the ticket.
--
-- Definitions match src/lib/colony/game.ts and timeline.ts:
--   - Unestimated tickets count as 1 story point.
--   - An active day is a UTC day with at least one merge.
--   - Cycle time runs from the first real (not synthetic) In Progress entry
--     to the merge, in hours per story point.
--   - Yield = (merge points + completion bonus) / story points merged, where
--     the bonus is the story points of every ticket in the epic.
WITH tickets AS (
  SELECT t.id, t."epicId", t.status, t."mergedAt",
         COALESCE(t."storyPoints", 1) AS sp,
         COALESCE(t."mergePoints", COALESCE(t."storyPoints", 1)) AS pts
  FROM ticket t
  WHERE t."scoutOf" IS NULL
),
merged AS (
  SELECT * FROM tickets WHERE status = 'merged' AND "mergedAt" IS NOT NULL
),
days AS (
  SELECT "mergedAt"::date AS day, SUM(sp) AS sp
  FROM merged GROUP BY 1
),
cycle AS (
  SELECT EXTRACT(EPOCH FROM (m."mergedAt" - s.started)) / 3600 / m.sp AS hours_per_sp
  FROM merged m
  JOIN (
    SELECT "ticketId", MIN("enteredAt") AS started
    FROM ticket_column_entry
    WHERE "column" = 'in_progress' AND NOT synthetic
    GROUP BY "ticketId"
  ) s ON s."ticketId" = m.id
  WHERE m."mergedAt" > s.started
),
yields AS (
  SELECT e.id,
         (SUM(t.pts) FILTER (WHERE t.status = 'merged') + SUM(t.sp))::numeric
           / NULLIF(SUM(t.sp) FILTER (WHERE t.status = 'merged'), 0) AS ratio
  FROM epic e JOIN tickets t ON t."epicId" = e.id
  WHERE e.status = 'merged'
  GROUP BY e.id
),
y AS (SELECT ratio FROM yields WHERE ratio IS NOT NULL)
SELECT metric, value FROM (
  SELECT 1 AS n, 'Merged tickets' AS metric, (SELECT COUNT(*) FROM merged)::text AS value
  UNION ALL SELECT 2, 'First merge day', (SELECT MIN(day) FROM days)::text
  UNION ALL SELECT 3, 'Last merge day', (SELECT MAX(day) FROM days)::text
  UNION ALL SELECT 4, 'Active days', (SELECT COUNT(*) FROM days)::text
  UNION ALL SELECT 5, 'SP per active day: median',
    (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY sp)::numeric, 2) FROM days)::text
  UNION ALL SELECT 6, 'SP per active day: p90',
    (SELECT ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY sp)::numeric, 2) FROM days)::text
  UNION ALL SELECT 7, 'SP per active day: last 14 active days',
    (SELECT string_agg(day || '=' || sp, ', ' ORDER BY day)
       FROM (SELECT * FROM days ORDER BY day DESC LIMIT 14) d)
  UNION ALL SELECT 8, 'Tickets with a cycle time', (SELECT COUNT(*) FROM cycle)::text
  UNION ALL SELECT 9, 'Hours per SP: median',
    (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_per_sp)::numeric, 2) FROM cycle)::text
  UNION ALL SELECT 10, 'Hours per SP: p90',
    (SELECT ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY hours_per_sp)::numeric, 2) FROM cycle)::text
  UNION ALL SELECT 11, 'Merged epics with a yield', (SELECT COUNT(*) FROM y)::text
  UNION ALL SELECT 12, 'Yield: min / median / p90 / max',
    (SELECT ROUND(MIN(ratio), 2) || ' / '
          || ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio)::numeric, 2) || ' / '
          || ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY ratio)::numeric, 2) || ' / '
          || ROUND(MAX(ratio), 2) FROM y)
  UNION ALL SELECT 13, 'Yield histogram (0.25 buckets)',
    (SELECT string_agg(bucket || ': ' || n, ', ' ORDER BY bucket)
       FROM (SELECT ROUND(FLOOR(ratio * 4) / 4, 2) AS bucket, COUNT(*) AS n FROM y GROUP BY 1) h)
) rows
ORDER BY n;
