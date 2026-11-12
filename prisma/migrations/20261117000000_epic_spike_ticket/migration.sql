-- The spike an Epic was made from its findings. One Epic per spike.
ALTER TABLE "epic" ADD COLUMN "spikeTicketId" TEXT;

CREATE UNIQUE INDEX "epic_spikeTicketId_key" ON "epic"("spikeTicketId");
