-- Shared boards: everyone who can reach a repository works on one board for
-- it. Each person's runs use their own keys unless the owner shares theirs.
ALTER TABLE "project" ADD COLUMN "shareKeys" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "epic" ADD COLUMN "actorId" TEXT;
ALTER TABLE "ticket" ADD COLUMN "actorId" TEXT;

CREATE TABLE "project_member" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_member_pkey" PRIMARY KEY ("projectId","userId")
);
CREATE INDEX "project_member_userId_idx" ON "project_member"("userId");
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "member_agent" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,

    CONSTRAINT "member_agent_pkey" PRIMARY KEY ("projectId","userId","slot")
);
CREATE INDEX "member_agent_presetId_idx" ON "member_agent"("presetId");
ALTER TABLE "member_agent" ADD CONSTRAINT "member_agent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_agent" ADD CONSTRAINT "member_agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "member_agent" ADD CONSTRAINT "member_agent_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "agent_preset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
