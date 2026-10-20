-- The last reading of the host's own meter, to correct Formic's count of it.
CREATE TABLE "host_usage_check" (
    "id" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "host_usage_check_pkey" PRIMARY KEY ("id")
);
