-- Before runs recorded the agent they were dispatched with, a usage limit
-- could land on whichever agent a column ran at the time the failure was
-- read, not the one that hit it. Those marks can't be told apart from real
-- ones, so all current marks go. An agent that really is out fails its next
-- run and is marked again, this time on the right agent.
UPDATE "agent_preset" SET "limitedUntil" = NULL, "limitNote" = NULL WHERE "limitedUntil" IS NOT NULL;
