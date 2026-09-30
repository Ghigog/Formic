-- CreateEnum
CREATE TYPE "WorkType" AS ENUM ('bug', 'spike');

-- AlterTable
ALTER TABLE "epic" ADD COLUMN     "workType" "WorkType";

-- AlterTable
ALTER TABLE "ticket" ADD COLUMN     "workType" "WorkType";
