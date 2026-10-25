-- A CLI agent's credential lives in the repository's Actions secrets, under a
-- name Formic knows. Forget any copy Formic stored.
UPDATE "agent_preset"
SET "apiKeyCipher" = NULL, "apiKeyHint" = NULL
WHERE "provider" IN ('claude-code', 'codex', 'gemini-cli');
