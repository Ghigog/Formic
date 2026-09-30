-- Standalone tickets used to be keyed "T-1" always, so every one ever made
-- shared a key. They are now numbered per project like Epics are, and the
-- same never-reuse rule applies: this counter only ever goes up.
ALTER TABLE "project" ADD COLUMN "lastStandaloneTicketNumber" INTEGER NOT NULL DEFAULT 0;
