-- Three more ticket types; existing bug and spike rows keep their value.
ALTER TYPE "WorkType" ADD VALUE 'user_story';
ALTER TYPE "WorkType" ADD VALUE 'task';
ALTER TYPE "WorkType" ADD VALUE 'feature';

-- How bad a bug is.
CREATE TYPE "BugSeverity" AS ENUM ('low', 'medium', 'high', 'critical');
ALTER TABLE "epic" ADD COLUMN "bugSeverity" "BugSeverity";
ALTER TABLE "ticket" ADD COLUMN "bugSeverity" "BugSeverity";
