-- Calibrating writes a sentinel's rubric for the project; an audit is scored against it.
ALTER TABLE "audit" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'audit';
ALTER TABLE "audit" ADD COLUMN "rubric" JSONB;
