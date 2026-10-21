-- Tech debt: work an agent found outside its ticket, added as its own ticket.
ALTER TYPE "WorkType" ADD VALUE 'tech_debt';

-- What an agent proposes as follow-up tickets, for the person to add or dismiss.
ALTER TABLE "ticket" ADD COLUMN "followUps" JSONB NOT NULL DEFAULT '[]';
