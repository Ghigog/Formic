-- Locks shared across server instances: one queue pass or merge at a time per
-- repository, across every board on it.
CREATE TABLE "lease" (
    "key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lease_pkey" PRIMARY KEY ("key")
);
