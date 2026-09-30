-- CreateEnum
CREATE TYPE "RunTimeBudgetMode" AS ENUM ('OFF', 'PER_STORY_POINT', 'FLAT_MINUTES', 'PER_POINT');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "runTimeBudgetFlatMinutes" INTEGER,
ADD COLUMN     "runTimeBudgetMode" "RunTimeBudgetMode" NOT NULL DEFAULT 'PER_STORY_POINT',
ADD COLUMN     "runTimeBudgetPerPointMinutes" JSONB;
