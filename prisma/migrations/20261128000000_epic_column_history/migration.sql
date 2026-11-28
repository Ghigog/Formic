-- Every column an Epic enters and leaves, as tickets have, so the tokens its
-- Product, Architect, showcase and chat runs use can be counted per column.
CREATE TABLE "epic_column_entry" (
    "id" TEXT NOT NULL,
    "epicId" TEXT NOT NULL,
    "column" "ColumnId" NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),
    "synthetic" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "epic_column_entry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "epic_column_entry_epicId_idx" ON "epic_column_entry"("epicId");

ALTER TABLE "epic_column_entry" ADD CONSTRAINT "epic_column_entry_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epics that already exist: one open entry at the column they are in now,
-- flagged synthetic because when they got there is only a guess.
INSERT INTO "epic_column_entry" ("id", "epicId", "column", "enteredAt", "synthetic")
SELECT
    gen_random_uuid()::text,
    e."id",
    c."column",
    CASE WHEN c."column" = 'backlog' THEN e."createdAt" ELSE e."updatedAt" END,
    true
FROM "epic" e
CROSS JOIN LATERAL (
    SELECT COALESCE(
        e."misplacedIn",
        CASE
            WHEN e."status" IN ('blocked', 'failed') AND e."stalledIn" IS NOT NULL THEN e."stalledIn"
            WHEN e."status" IN ('draft', 'specified') THEN 'backlog'::"ColumnId"
            WHEN e."status" IN ('ready', 'waiting', 'blocked', 'failed') THEN 'todo'::"ColumnId"
            WHEN e."status" IN ('queued', 'running') THEN 'in_progress'::"ColumnId"
            WHEN e."status" = 'review' THEN 'in_review'::"ColumnId"
            ELSE 'done'::"ColumnId"
        END
    ) AS "column"
) c;
