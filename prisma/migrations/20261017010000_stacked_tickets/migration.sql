-- Stacked pull requests: the prerequisite's branch a ticket builds on, until
-- that prerequisite merges and its pull request is retargeted.
ALTER TABLE "ticket" ADD COLUMN "stackedOn" TEXT;
