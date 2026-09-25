-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('draft', 'specified', 'ready', 'waiting', 'running', 'review', 'merged', 'blocked', 'failed');

-- CreateEnum
CREATE TYPE "ColumnId" AS ENUM ('backlog', 'todo', 'in_progress', 'in_review', 'done');

-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('product', 'architect', 'coder', 'reviewer', 'pm');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled');

-- CreateEnum
CREATE TYPE "TicketSize" AS ENUM ('S', 'M', 'L', 'XL');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('image', 'file');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "githubId" INTEGER NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "githubTokenCipher" TEXT,
    "githubTokenExpiresAt" TIMESTAMP(3),
    "githubRefreshCipher" TEXT,
    "githubRefreshExpiresAt" TIMESTAMP(3),
    "e2bKeyCipher" TEXT,
    "e2bKeyHint" TEXT,
    "anthropicKeyCipher" TEXT,
    "anthropicKeyHint" TEXT,
    "termsAcceptedVersion" TEXT,
    "termsAcceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL DEFAULT 'main',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assistantPresetId" TEXT,
    "lastEpicNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epic" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "number" INTEGER,
    "title" TEXT NOT NULL,
    "rawRequest" TEXT NOT NULL,
    "prd" JSONB,
    "prdEditedByHuman" BOOLEAN NOT NULL DEFAULT false,
    "prdUpdatedAt" TIMESTAMP(3),
    "showcase" TEXT,
    "runnerJob" TEXT,
    "runnerAgent" TEXT,
    "runnerJobAt" TIMESTAMP(3),
    "issueNumber" INTEGER,
    "status" "TicketStatus" NOT NULL DEFAULT 'draft',
    "stalledIn" "ColumnId",
    "stage" INTEGER NOT NULL DEFAULT 1,
    "blockedReason" TEXT,
    "misplacedIn" "ColumnId",
    "misplacedReason" TEXT,
    "standalone" BOOLEAN NOT NULL DEFAULT false,
    "rerouteFrom" "ColumnId",
    "rerouteReason" TEXT,
    "position" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "epic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket" (
    "id" TEXT NOT NULL,
    "epicId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "acceptanceCriteria" TEXT[],
    "fileScope" TEXT[],
    "size" "TicketSize" NOT NULL DEFAULT 'M',
    "status" "TicketStatus" NOT NULL DEFAULT 'waiting',
    "stalledIn" "ColumnId",
    "stage" INTEGER NOT NULL DEFAULT 3,
    "position" DOUBLE PRECISION NOT NULL,
    "detached" BOOLEAN NOT NULL DEFAULT false,
    "misplacedIn" "ColumnId",
    "misplacedReason" TEXT,
    "rerouteFrom" "ColumnId",
    "rerouteReason" TEXT,
    "branchName" TEXT,
    "summary" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "blockedReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runnerJob" TEXT,
    "runnerAgent" TEXT,
    "runnerJobAt" TIMESTAMP(3),
    "issueNumber" INTEGER,
    "storyPoints" INTEGER,
    "plan" JSONB,
    "handoff" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "needsHuman" TEXT,
    "reviewedSha" TEXT,
    "mergedAt" TIMESTAMP(3),
    "mergePoints" INTEGER,
    "mergeMultiplier" DOUBLE PRECISION,
    "costCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_dependency" (
    "ticketId" TEXT NOT NULL,
    "dependsOnTicketId" TEXT NOT NULL,

    CONSTRAINT "ticket_dependency_pkey" PRIMARY KEY ("ticketId","dependsOnTicketId")
);

-- CreateTable
CREATE TABLE "agent_run" (
    "id" TEXT NOT NULL,
    "role" "AgentRole" NOT NULL,
    "epicId" TEXT,
    "ticketId" TEXT,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'queued',
    "model" TEXT,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sandboxId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "key" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "epicId" TEXT,
    "ticketId" TEXT,
    "requestId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event" (
    "seq" BIGSERIAL NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "agent_preset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "apiKeyCipher" TEXT,
    "apiKeyHint" TEXT,
    "limitedUntil" TIMESTAMP(3),
    "limitNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_preset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "column_agent" (
    "projectId" TEXT NOT NULL,
    "column" "ColumnId" NOT NULL,
    "presetId" TEXT NOT NULL,

    CONSTRAINT "column_agent_pkey" PRIMARY KEY ("projectId","column")
);

-- CreateTable
CREATE TABLE "assistant_message" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "proposals" JSONB,
    "status" TEXT NOT NULL DEFAULT 'done',
    "runnerJob" TEXT,
    "runnerAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_chat_message" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cardKind" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'done',
    "runnerJob" TEXT,
    "runnerAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_chat_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_githubId_key" ON "user"("githubId");

-- CreateIndex
CREATE INDEX "project_ownerId_idx" ON "project"("ownerId");

-- CreateIndex
CREATE INDEX "epic_projectId_status_idx" ON "epic"("projectId", "status");

-- CreateIndex
CREATE INDEX "ticket_epicId_status_idx" ON "ticket"("epicId", "status");

-- CreateIndex
CREATE INDEX "ticket_mergedAt_idx" ON "ticket"("mergedAt");

-- CreateIndex
CREATE INDEX "ticket_prNumber_idx" ON "ticket"("prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_epicId_key_key" ON "ticket"("epicId", "key");

-- CreateIndex
CREATE INDEX "ticket_dependency_dependsOnTicketId_idx" ON "ticket_dependency"("dependsOnTicketId");

-- CreateIndex
CREATE INDEX "agent_run_status_idx" ON "agent_run"("status");

-- CreateIndex
CREATE INDEX "agent_run_ticketId_idx" ON "agent_run"("ticketId");

-- CreateIndex
CREATE INDEX "agent_run_epicId_idx" ON "agent_run"("epicId");

-- CreateIndex
CREATE INDEX "webhook_delivery_receivedAt_idx" ON "webhook_delivery"("receivedAt");

-- CreateIndex
CREATE INDEX "attachment_requestId_idx" ON "attachment"("requestId");

-- CreateIndex
CREATE INDEX "attachment_epicId_idx" ON "attachment"("epicId");

-- CreateIndex
CREATE INDEX "attachment_ticketId_idx" ON "attachment"("ticketId");

-- CreateIndex
CREATE INDEX "event_projectId_seq_idx" ON "event"("projectId", "seq");

-- CreateIndex
CREATE INDEX "agent_preset_ownerId_idx" ON "agent_preset"("ownerId");

-- CreateIndex
CREATE INDEX "column_agent_presetId_idx" ON "column_agent"("presetId");

-- CreateIndex
CREATE INDEX "assistant_message_projectId_createdAt_idx" ON "assistant_message"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "card_chat_message_cardId_createdAt_idx" ON "card_chat_message"("cardId", "createdAt");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epic" ADD CONSTRAINT "epic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_dependency" ADD CONSTRAINT "ticket_dependency_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_dependency" ADD CONSTRAINT "ticket_dependency_dependsOnTicketId_fkey" FOREIGN KEY ("dependsOnTicketId") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_preset" ADD CONSTRAINT "agent_preset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "column_agent" ADD CONSTRAINT "column_agent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "column_agent" ADD CONSTRAINT "column_agent_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "agent_preset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_message" ADD CONSTRAINT "assistant_message_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "card_chat_message" ADD CONSTRAINT "card_chat_message_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

