-- AlterTable
ALTER TABLE "ticket" ADD COLUMN     "scopeRequest" TEXT[] DEFAULT ARRAY[]::TEXT[];
