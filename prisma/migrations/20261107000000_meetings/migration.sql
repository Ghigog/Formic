CREATE TABLE "meeting" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "agenda" TEXT NOT NULL DEFAULT '',
    "guests" JSONB NOT NULL DEFAULT '[]',
    "repeat" TEXT NOT NULL DEFAULT 'none',
    "lastRemindedFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_message" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "meetingId" TEXT,
    "role" TEXT NOT NULL,
    "guestId" TEXT,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'done',
    "runnerJob" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "meeting_projectId_startsAt_idx" ON "meeting"("projectId", "startsAt");
CREATE INDEX "call_message_projectId_createdAt_idx" ON "call_message"("projectId", "createdAt");
CREATE INDEX "call_message_meetingId_createdAt_idx" ON "call_message"("meetingId", "createdAt");

ALTER TABLE "meeting" ADD CONSTRAINT "meeting_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_message" ADD CONSTRAINT "call_message_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "call_message" ADD CONSTRAINT "call_message_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
