-- The files a ticket asked for outside its file scope. The column reached
-- the schema without a migration, so a database built from migrations
-- lacked it. IF NOT EXISTS keeps it a no-op where `db push` already added it.
ALTER TABLE "ticket" ADD COLUMN IF NOT EXISTS "scopeRequest" TEXT[] DEFAULT ARRAY[]::TEXT[];
