-- Auto-merge is opt-in: a new project starts with it off. Existing projects keep their value.
ALTER TABLE "project" ALTER COLUMN "autoMerge" SET DEFAULT false;
