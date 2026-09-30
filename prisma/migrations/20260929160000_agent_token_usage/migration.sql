-- What an agent has used, in tokens, is summed from the work it did: its runs
-- and the chat answers it gave. Runs carry the preset that ran them from here
-- on; the chat message's own field for that is renamed, because a chat answer
-- does not always have a run behind it — an answer Formic makes itself is not
-- one — and the field is what says which agent spent those tokens.
ALTER TABLE "agent_run" ADD COLUMN "presetId" TEXT;
CREATE INDEX "agent_run_presetId_createdAt_idx" ON "agent_run"("presetId", "createdAt");

ALTER TABLE "card_chat_message" RENAME COLUMN "runnerAgent" TO "agentPresetId";
CREATE INDEX "card_chat_message_agentPresetId_createdAt_idx" ON "card_chat_message"("agentPresetId", "createdAt");
