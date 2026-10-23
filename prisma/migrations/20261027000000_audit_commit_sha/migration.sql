-- The commit an audit read, so an epic can say which code it came from.
ALTER TABLE "audit" ADD COLUMN "commitSha" TEXT;
