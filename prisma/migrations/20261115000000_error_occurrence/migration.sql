-- Errors counted across instances, to page once on a spike.
CREATE TABLE "error_occurrence" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_occurrence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "error_occurrence_at_idx" ON "error_occurrence"("at");
