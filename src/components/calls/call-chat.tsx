"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MarkdownLite } from "@/components/ui/markdown-lite";
import { cn } from "@/components/ui/cn";
import { guestLabel } from "@/lib/calls/guests";
import { useCall, type CallMessageView } from "@/lib/hooks/use-call";

function Message({ m }: { m: CallMessageView }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-column text-fg max-w-[85%] rounded-xl rounded-br-sm px-3 py-2 text-[13px] leading-5 whitespace-pre-wrap">
          {m.content}
        </div>
      </div>
    );
  }
  const who = m.guestId ? guestLabel(m.guestId) : "PM";
  return (
    <div className="max-w-[92%] text-[13px] leading-[1.55]">
      <p className="text-fg-subtle mb-0.5 text-[11px] font-medium">{who}</p>
      {m.status === "pending" && (
        <div className="text-fg-subtle flex items-center gap-2" role="status">
          <span className="bg-clay size-1.5 shrink-0 animate-pulse rounded-full" aria-hidden />
          {m.content || "Thinking…"}
        </div>
      )}
      {m.status === "failed" && <p className="text-crimson-text whitespace-pre-wrap">{m.content}</p>}
      {m.status === "done" && m.content && (
        <div className="text-fg">
          <MarkdownLite text={m.content} keepLineBreaks />
        </div>
      )}
    </div>
  );
}

/** A call: its agenda, who is on it, the messages so far, and a box to talk to the guests. */
export function CallChat({ meetingId }: { meetingId: string }) {
  const c = useCall(meetingId);
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
    <div className="mx-auto flex h-dvh max-w-2xl flex-col">
      <header className="border-line shrink-0 border-b p-3">
        <h1 className="text-fg text-[15px] font-semibold">{c.meeting?.title ?? "Call"}</h1>
        {c.meeting && (
          <p className="text-fg-subtle text-[12px]">
            With {c.meeting.guests.length ? c.meeting.guests.map(guestLabel).join(", ") : "the PM"}
          </p>
        )}
        {c.meeting?.agenda && (
          <div className="text-fg mt-2 text-[12px]" aria-label="Agenda">
            <MarkdownLite text={c.meeting.agenda} keepLineBreaks />
          </div>
        )}
      </header>
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {c.messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {c.error && (
          <p role="alert" className="text-crimson-text text-[12px]">
            {c.error}
          </p>
        )}
      </div>
      <form onSubmit={(e) => void submit(e)} className="border-line shrink-0 border-t p-2">
        <div className="flex items-end gap-2">
          <label htmlFor="call-message" className="sr-only">
            Message the call
          </label>
          <textarea
            id="call-message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={4_000}
            placeholder={c.pending ? "Answering…" : "Say something. Name a guest to ask them."}
            className="border-line bg-surface text-fg placeholder:text-fg-subtle flex-1 resize-none rounded-md border px-2 py-1.5 text-[13px] leading-5"
          />
          <button
            type="submit"
            disabled={!text.trim() || c.pending}
            className={cn("bg-amber text-on-amber rounded px-2.5 py-1.5 text-[13px] font-medium disabled:opacity-50")}
          >
            {c.pending ? "…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
