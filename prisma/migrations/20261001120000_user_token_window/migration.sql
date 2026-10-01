-- AlterTable
ALTER TABLE "user" ADD COLUMN     "tokenRenewalDay" INTEGER,
ADD COLUMN     "tokenResetAt" TIMESTAMP(3),
ADD COLUMN     "tokenWindowTimezone" TEXT;
