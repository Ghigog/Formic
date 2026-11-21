-- AlterTable
ALTER TABLE "project" ADD COLUMN "pmFixCap" INTEGER,
ADD COLUMN "pmWakesPerHour" INTEGER,
ADD COLUMN "pmWakesPerDay" INTEGER;

-- CreateTable
CREATE TABLE "pm_wake" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "head" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pm_wake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pm_wake_projectId_createdAt_idx" ON "pm_wake"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "pm_wake_projectId_cardId_idx" ON "pm_wake"("projectId", "cardId");

-- AddForeignKey
ALTER TABLE "pm_wake" ADD CONSTRAINT "pm_wake_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
