"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { cn } from "@/components/ui/cn";
import { useCardChat, type CardChatMessageView } from "@/lib/hooks/use-card-chat";

function Message({ m }: { m: CardChatMessageView }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-column text-fg max-w-[85%] rounded-xl rounded-br-sm px-3 py-2 text-[12px] leading-5 whitespace-pre-wrap">
          {m.content}
        </div>
      </div>
    );
  }
  if (m.status === "pending") {
    return (
      <div className="text-fg-subtle flex items-center gap-2 text-[12px]" role="status">
        <span className="bg-clay size-1.5 animate-pulse rounded-full" aria-hidden />
        Thinking…
      </div>
    );
  }
  return (
    <div
      className={cn(
        "max-w-[92%] text-[12px] leading-[1.55] whitespace-pre-wrap",
        m.status === "failed" ? "text-crimson-text" : "text-fg",
      )}
    >
      {m.content}
    </div>
  );
}

/**
 * A live chat with the agent running this card's column now: the Product
 * Agent for an Epic in Backlog, the Architect Agent for a ticket in To Do,
 * and so on as the card moves. It reads the card and the repository; it
 * cannot change either.
 */
export function CardChat({
  kind,
  cardId,
  agentLabel,
}: {
  kind: "epic" | "ticket";
  cardId: string;
  agentLabel: string;
}) {
  const c = useCardChat(kind, cardId);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.scrollTo?.({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [c.messages.length]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || c.pending) return;
    setText("");
    await c.ask(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e as unknown as FormEvent);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {c.messages.length === 0 ? (
          <p className="text-fg-subtle text-[12px] leading-5">
            {kind === "epic"
              ? `Chat with the ${agentLabel} Agent about this Epic.`
              : `Chat with the ${agentLabel} Agent about this ticket. Any agent working it, and every later run, reads what you send.`}
          </p>
        ) : (
          c.messages.map((m) => <Message key={m.id} m={m} />)
        )}
        {c.error && (
          <p role="alert" className="text-crimson-text text-[12px]">
            {c.error}
          </p>
        )}
      </div>
      <form
        onSubmit={(e) => void submit(e)}
        className="border-line shrink-0 border-t p-2"
      >
        <div className="flex items-end gap-2">
          <label htmlFor={`chat-${cardId}`} className="sr-only">
            Ask the {agentLabel} Agent
          </label>
          <textarea
            id={`chat-${cardId}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={4_000}
            placeholder={c.pending ? "Answering…" : `Ask the ${agentLabel} Agent…`}
            className="border-line bg-surface text-fg placeholder:text-fg-subtle flex-1 resize-none rounded-md border px-2 py-1.5 text-[12px] leading-5"
          />
          <button
            type="submit"
            disabled={!text.trim() || c.pending}
            className="bg-amber text-on-amber rounded px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-50"
          >
            {c.pending ? "…" : "Send"}
          </button>
        </div>
        {c.messages.length > 0 && (
          <button
            type="button"
            onClick={() => void c.clear()}
            disabled={c.pending}
            className="text-fg-subtle hover:text-fg mt-1.5 text-[11px] disabled:opacity-50"
          >
            Clear chat
          </button>
        )}
      </form>
    </div>
  );
}
