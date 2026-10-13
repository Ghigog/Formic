-- Auto story point escalation: a per-project opt-in (off by default) and a
-- per-ticket marker so a ticket is only escalated once.
ALTER TABLE "project" ADD COLUMN "autoEscalate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ticket" ADD COLUMN "autoEscalatedAt" TIMESTAMP(3);
