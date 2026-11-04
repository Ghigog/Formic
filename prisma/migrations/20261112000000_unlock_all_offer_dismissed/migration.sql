-- The offer to unlock every Sentinel is remembered on the project, so a new
-- device does not ask again. Null until it is dismissed.
ALTER TABLE "project" ADD COLUMN "unlockAllOfferDismissedAt" TIMESTAMP(3);
