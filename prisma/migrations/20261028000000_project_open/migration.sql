-- When each person last opened each board, for the repo picker's order.
CREATE TABLE "project_open" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_open_pkey" PRIMARY KEY ("projectId","userId")
);
CREATE INDEX "project_open_userId_idx" ON "project_open"("userId");
ALTER TABLE "project_open" ADD CONSTRAINT "project_open_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_open" ADD CONSTRAINT "project_open_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
