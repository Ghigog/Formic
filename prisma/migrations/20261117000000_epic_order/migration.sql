-- AlterTable
ALTER TABLE "ticket" ADD COLUMN "moveOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "lastCommitAt" TIMESTAMP(3),
ADD COLUMN "stuckNote" TEXT;

-- CreateTable
CREATE TABLE "epic_dependency" (
    "epicId" TEXT NOT NULL,
    "waitsForEpicId" TEXT NOT NULL,

    CONSTRAINT "epic_dependency_pkey" PRIMARY KEY ("epicId","waitsForEpicId")
);

-- CreateIndex
CREATE INDEX "epic_dependency_waitsForEpicId_idx" ON "epic_dependency"("waitsForEpicId");

-- AddForeignKey
ALTER TABLE "epic_dependency" ADD CONSTRAINT "epic_dependency_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epic_dependency" ADD CONSTRAINT "epic_dependency_waitsForEpicId_fkey" FOREIGN KEY ("waitsForEpicId") REFERENCES "epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
