-- The head a review has already been given, whether it answered or not. A
-- commit finishing several checks arrives as that many reports, and without
-- this each of them starts its own review of that head: a ticket's whole
-- review ceiling spent on one CI run, and a card parked saying it was
-- reviewed four times when nothing was read.
ALTER TABLE "ticket" ADD COLUMN "reviewedHead" TEXT;
