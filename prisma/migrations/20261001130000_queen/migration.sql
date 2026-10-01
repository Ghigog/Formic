ALTER TABLE "project" ADD COLUMN "queensSpent" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "queen" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "epicId" TEXT,
    "ticketId" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queen_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "queen_epicId_key" ON "queen"("epicId");
CREATE UNIQUE INDEX "queen_ticketId_key" ON "queen"("ticketId");
CREATE INDEX "queen_projectId_idx" ON "queen"("projectId");

ALTER TABLE "queen" ADD CONSTRAINT "queen_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "queen" ADD CONSTRAINT "queen_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "queen" ADD CONSTRAINT "queen_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
