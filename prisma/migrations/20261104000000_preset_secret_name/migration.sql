-- A CLI agent can name the Actions secret it signs in with, so agents can
-- share one or each use their own.
ALTER TABLE "agent_preset" ADD COLUMN "secretName" TEXT;
