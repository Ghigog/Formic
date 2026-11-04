-- Who a reply in the general chat comes from: "assistant", a column role or "sentinel:<id>".
ALTER TABLE "assistant_message" ADD COLUMN "speaker" TEXT NOT NULL DEFAULT 'assistant';
