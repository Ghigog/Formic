-- AlterTable
ALTER TABLE "user" ADD COLUMN     "fallbackSandboxMonth" TEXT,
ADD COLUMN     "fallbackSandboxSeconds" INTEGER NOT NULL DEFAULT 0;
