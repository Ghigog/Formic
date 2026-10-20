-- Thinking effort that follows a ticket's story points: on by default.
ALTER TABLE "user" ADD COLUMN "effortByPoints" BOOLEAN NOT NULL DEFAULT true;
