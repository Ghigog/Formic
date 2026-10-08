-- CreateTable
CREATE TABLE "platform_usage" (
    "day" TEXT NOT NULL,
    "requests" BIGINT NOT NULL DEFAULT 0,
    "busyMs" BIGINT NOT NULL DEFAULT 0,
    "cpuMs" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_usage_pkey" PRIMARY KEY ("day")
);
