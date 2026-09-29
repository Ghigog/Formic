-- A card's chat answer is not a run: it moves no card and leaves no run row,
-- so nothing wrote down what it spent. The message it lands on is where that
-- goes now, for the answers Formic makes itself. A CLI agent's answer keeps
-- zeros here: the Actions job it ran in is its run, and that run is what its
-- spend is counted against.
ALTER TABLE "card_chat_message"
  ADD COLUMN "tokensIn" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "tokensOut" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "costCents" DOUBLE PRECISION NOT NULL DEFAULT 0;
