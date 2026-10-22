-- Every column a ticket enters and leaves, and the changes made to it after
-- it was planned, so KPIs can be derived from real history.
CREATE TYPE "TicketChangeKind" AS ENUM ('points', 'edit', 'split');

CREATE TABLE "ticket_column_entry" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "column" "ColumnId" NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),
    "synthetic" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ticket_column_entry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ticket_change" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" "TicketChangeKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB,

    CONSTRAINT "ticket_change_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ticket_column_entry_ticketId_idx" ON "ticket_column_entry"("ticketId");
CREATE INDEX "ticket_change_ticketId_idx" ON "ticket_change"("ticketId");

ALTER TABLE "ticket_column_entry" ADD CONSTRAINT "ticket_column_entry_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ticket_change" ADD CONSTRAINT "ticket_change_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tickets that already exist: one open entry at the column they are in now,
-- flagged synthetic because when they got there is only a guess (their last
-- update; their creation for the Backlog). Scouts are not on the board.
INSERT INTO "ticket_column_entry" ("id", "ticketId", "column", "enteredAt", "synthetic")
SELECT
    gen_random_uuid()::text,
    t."id",
    c."column",
    CASE WHEN c."column" = 'backlog' THEN t."createdAt" ELSE t."updatedAt" END,
    true
FROM "ticket" t
CROSS JOIN LATERAL (
    SELECT COALESCE(
        t."misplacedIn",
        CASE
            WHEN t."status" IN ('blocked', 'failed') AND t."stalledIn" IS NOT NULL THEN t."stalledIn"
            WHEN t."status" IN ('draft', 'specified') THEN 'backlog'::"ColumnId"
            WHEN t."status" IN ('ready', 'waiting', 'blocked', 'failed') THEN 'todo'::"ColumnId"
            WHEN t."status" IN ('queued', 'running') THEN 'in_progress'::"ColumnId"
            WHEN t."status" = 'review' THEN 'in_review'::"ColumnId"
            ELSE 'done'::"ColumnId"
        END
    ) AS "column"
) c
WHERE t."scoutOf" IS NULL;
