"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MarkdownLite } from "@/components/ui/markdown-lite";
import { cn } from "@/components/ui/cn";
import { guestLabel, type GuestId } from "@/lib/calls/guests";
import { useCall, type CallMessageView } from "@/lib/hooks/use-call";
import { CallsHeader, GuestCoin } from "./calls-chrome";

/** What the person might say first, to show how a call works. */
const OPENERS = ["Hello everyone", "What's on the docket today?", "Get the Coder in"];

/** The line a guest says when it needs longer: see GET_BACK in src/lib/calls/turn.ts. */
const GET_BACK = "Let me get back to you on that.";

function Typing() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="bg-clay size-1.5 animate-pulse rounded-full" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </span>
  );
}

function Message({ m }: { m: CallMessageView }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-anthracite text-cream max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-[14px] leading-6 whitespace-pre-wrap">
          {m.content}
        </div>
      </div>
    );
  }
  const guest: GuestId = m.guestId ?? "assistant";
  const later = m.content === GET_BACK;
  return (
    <div className="flex max-w-[92%] items-start gap-2.5">
      <GuestCoin id={guest} />
      <div className="min-w-0">
        <p className="text-muted mb-1 font-mono text-[10px] tracking-[0.08em] uppercase">{guestLabel(guest)}</p>
        <div
          className={cn(
            "border-line bg-card text-ink rounded-2xl rounded-tl-md border px-3.5 py-2 text-[14px] leading-6",
            m.status === "failed" && "border-crimson/40 bg-crimson/5",
          )}
        >
          {m.status === "pending" && !m.content ? (
            <span role="status" aria-label={`${guestLabel(guest)} is answering`} className="flex h-6 items-center">
              <Typing />
            </span>
          ) : later ? (
            <span className="text-muted inline-flex items-center gap-2 italic" role={m.status === "pending" ? "status" : undefined}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.3" />
                <path d="M7 4v3.2l2 1.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              {m.content}
            </span>
          ) : m.status === "failed" ? (
            <p className="whitespace-pre-wrap">{m.content}</p>
          ) : (
            <MarkdownLite text={m.content} keepLineBreaks />
          )}
        </div>
      </div>
    </div>
  );
}

/** A call: its agenda, who is on it, the messages so far, and a box to talk to the guests. */
export function CallChat({ meetingId }: { meetingId: string }) {
  const c = useCall(meetingId);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

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

  const guests: GuestId[] = c.meeting?.guests.length ? c.meeting.guests : ["assistant"];

  return (
    <div className="bg-cream flex h-dvh flex-col">
      <CallsHeader back={{ href: "/calls", label: "Back to calls" }} kicker="On a call" title={c.meeting?.title ?? "Call"} />
      <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
        <div className="flex flex-col gap-3 px-4 pt-4">
          <div className="flex items-center gap-2" aria-label="On the call">
            <div className="flex -space-x-1.5">
              {guests.map((g) => (
                <span key={g} title={guestLabel(g)} className="ring-cream rounded-[9px] ring-2">
                  <GuestCoin id={g} size={30} />
                </span>
              ))}
            </div>
            <p className="text-muted text-[12px]">With {guests.map(guestLabel).join(", ")}</p>
          </div>
          {c.meeting?.agenda && (
            <details open className="bg-panel rounded-lg px-3 py-2">
              <summary className="text-ink cursor-pointer text-[11px] font-semibold tracking-[0.1em] uppercase">Agenda</summary>
              <div className="text-ink mt-1.5 text-[13px] leading-6" aria-label="Agenda">
                <MarkdownLite text={c.meeting.agenda} keepLineBreaks />
              </div>
            </details>
          )}
        </div>
        <div ref={list} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {c.messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <div>
                <p className="text-ink font-serif text-[22px] font-semibold">The line is open.</p>
                <p className="text-muted mt-1 max-w-sm text-[13px] leading-6">
                  Talk to everyone, or name a guest to ask them. Bring someone in with &ldquo;get the Reviewer in&rdquo;.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {OPENERS.map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => {
                      setText(o);
                      box.current?.focus();
                    }}
                    className="border-line bg-card text-ink hover:border-terracotta rounded-full border px-3 py-1.5 text-[13px]"
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          )}
          {c.messages.map((m) => (
            <Message key={m.id} m={m} />
          ))}
          {c.error && (
            <p role="alert" className="bg-crimson/10 text-ink rounded-md px-3 py-2 text-[13px]">
              {c.error}
            </p>
          )}
        </div>
        <form onSubmit={(e) => void submit(e)} className="shrink-0 px-4 pt-1 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="border-line bg-card focus-within:border-terracotta flex items-end gap-2 rounded-2xl border p-1.5 pl-3.5 shadow-[0_8px_24px_-16px_color-mix(in_srgb,var(--anthracite)_40%,transparent)]">
            <label htmlFor="call-message" className="sr-only">
              Message the call
            </label>
            <textarea
              id="call-message"
              ref={box}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              maxLength={4_000}
              placeholder={c.pending ? "Answering…" : "Say something. Name a guest to ask them."}
              className="text-ink placeholder:text-muted max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-6 outline-none"
            />
            <button
              type="submit"
              aria-label="Send"
              disabled={!text.trim() || c.pending}
              className="bg-terracotta-cta inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-white disabled:opacity-40"
            >
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
