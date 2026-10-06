-- The GitHub issue a ticket was imported from. A person labels an issue
-- `formic: intake`, the intake makes the ticket from it, and the mirror adopts
-- that issue as the ticket's own rather than filing a second one — so the pull
-- request says `Closes #<their issue>` and their issue is the one that closes.
-- Null for every ticket Formic made itself.
ALTER TABLE "ticket" ADD COLUMN "sourceIssueNumber" INTEGER;