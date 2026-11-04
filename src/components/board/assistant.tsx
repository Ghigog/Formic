"use client";

import { AutoTour } from "@/components/onboarding/tour";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AgentSelect } from "./agent-select";
import { CallBar } from "@/components/call/call-bar";
import { UNSUPPORTED_TITLE, useCall } from "@/components/call/call-provider";
import { useDraft } from "./use-draft";
import { cn } from "@/components/ui/cn";
import { MarkdownLite } from "@/components/ui/markdown-lite";
import { GuestCoin } from "@/components/meetings/guest-coin";
import { guestLabel, type GuestId } from "@/lib/meetings/guests";
import type { AgentPreset } from "@/lib/domain/entities";
import type { AssistantMessageView } from "@/lib/hooks/use-assistant";
import { useKeyboardInset } from "@/lib/hooks/use-keyboard-inset";
import { provider as providerInfo } from "@/lib/llm/providers";

/**
 * The board's assistant: ask anything about the repository from the top
 * bar, and the answer pulls down over the board like a sun visor. An arrow
 * at its bottom right rolls it back up; the conversation stays for next
 * time.
 *
 * It can read the repository and propose changes to the board. Nothing it
 * proposes happens until the person presses Approve.
 */

export interface AssistantControls {
  open: boolean;
  setOpen: (open: boolean) => void;
  presetId: string | null;
  messages: AssistantMessageView[];
  pending: boolean;
  error: string | null;
  /** Sends a message; `speakers` are who answers it, in order (the PM by default). */
  ask: (text: string, speakers?: string[]) => Promise<void>;
  stop: () => void;
  clear: () => Promise<void>;
  decide: (
    messageId: string,
    index: number,
    decision: "apply" | "dismiss",
  ) => Promise<void>;
  /** Has the PM open a call: the questions waiting on the person, or a greeting. */
  openCall?: () => Promise<void>;
  setAgent: (presetId: string | null) => Promise<void>;
  presets: AgentPreset[];
  /** How many cards are waiting on a question for the person, which the PM relays. */
  questions?: number;
  /** The questions themselves, shown at the bottom of the PM's chat, after the newest message; each opens its card, where it is answered. */
  waiting?: Array<{ id: string; key: string; title: string; question: string }>;
  onOpenQuestion?: (cardId: string) => void;
  /** Opens the agent editor: an existing preset, or null for a new one. */
  onEdit: (preset: AgentPreset | null) => void;
}

function Chevron({ up = false, size = 12 }: { up?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{
        transform: up ? "rotate(180deg)" : undefined,
        transition: "transform 200ms",
      }}
    >
      <path
        d="M3 4.5 6 7.5 9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M6.6 3.5h3l1.4 4-2 1.3a11 11 0 0 0 5.2 5.2l1.3-2 4 1.4v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Starts a call with the PM; the tap itself starts the microphone. */
function CallButton() {
  const call = useCall();
  if (!call) return null;
  const disabled = call.live || !call.supported;
  return (
    <button
      type="button"
      data-tour="agent-call"
      onClick={() => call.start()}
      disabled={disabled}
      aria-label="Call the PM"
      title={
        call.supported
          ? call.live
            ? "You are on a call"
            : "Call the PM"
          : UNSUPPORTED_TITLE
      }
      className="bg-card border-line text-ink hover:border-clay inline-flex size-11 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50 disabled:hover:border-line md:size-8"
    >
      <PhoneIcon />
    </button>
  );
}

function SparkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7 1.5v2.2M7 10.3v2.2M1.5 7h2.2M10.3 7h2.2M3.1 3.1l1.5 1.5M9.4 9.4l1.5 1.5M3.1 10.9l1.5-1.5M9.4 4.6l1.5-1.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The composer: a line in the top bar on desktop, the shade's foot on mobile. */
function Composer({
  a,
  repoName,
  className,
  onAsked,
  toggle = true,
}: {
  a: AssistantControls;
  repoName: string;
  className?: string;
  onAsked?: () => void;
  /** The pull-down arrow. Off inside the shade, which has its own. */
  toggle?: boolean;
}) {
  const [text, setText] = useDraft("assistant");
  const field = useRef<HTMLTextAreaElement>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value) return;
    a.setOpen(true);
    setText("");
    await a.ask(value);
    onAsked?.();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") a.setOpen(false);
    // Enter sends (also with Cmd/Ctrl); Shift+Enter is the textarea's own
    // newline. Enter that confirms an IME composition is not a send.
    else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className={cn("relative flex items-center", className)}
    >
      <span className="text-muted pointer-events-none absolute left-3">
        <SparkIcon />
      </span>
      <textarea
        ref={field}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => a.messages.length > 0 && a.setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={
          a.pending
            ? "Answering… you can keep typing"
            : a.questions
              ? `The PM has ${a.questions === 1 ? "a question" : `${a.questions} questions`} for you…`
              : `Ask the PM about ${repoName}…`
        }
        aria-label="Ask the PM"
        className={cn(
          "border-line bg-cream text-ink placeholder:text-muted h-9 w-full resize-none rounded-lg border py-[7px] pl-9 text-[13px] leading-5 outline-none focus:border-terracotta",
          toggle ? "pr-[4.5rem]" : "pr-10",
        )}
      />
      {a.pending && !text.trim() ? (
        <button
          type="button"
          onClick={() => {
            a.stop();
            field.current?.focus();
          }}
          aria-label="Stop"
          className={cn(
            "text-ink hover:bg-column absolute inline-flex size-8 items-center justify-center rounded-md",
            toggle ? "right-9" : "right-1",
          )}
        >
          <span className="bg-ink size-2.5 rounded-[2px]" aria-hidden />
        </button>
      ) : (
        <button
          type="submit"
          aria-label="Send"
          className={cn(
            "text-muted hover:text-ink absolute inline-flex size-8 items-center justify-center rounded-md",
            toggle ? "right-9" : "right-1",
          )}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M6 10V2M2.5 5.5 6 2l3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {toggle && (
        <button
          type="button"
          onClick={() => a.setOpen(!a.open)}
          aria-label={a.open ? "Roll the PM up" : "Pull the PM down"}
          aria-expanded={a.open}
          className="text-muted hover:text-ink absolute right-1 inline-flex size-8 items-center justify-center rounded-md"
        >
          <Chevron up={a.open} />
        </button>
      )}
    </form>
  );
}

/** The top bar's ask box, with the shade hanging from it. Desktop only. */
export function AskBox({
  a,
  repoName,
}: {
  a: AssistantControls;
  repoName: string;
}) {
  return (
    <div data-tour="chat" className="relative w-full max-w-[520px]">
      <Composer a={a} repoName={repoName} />
      <Shade
        a={a}
        repoName={repoName}
        className="fixed top-16 left-1/2 w-[min(920px,calc(100vw-48px))] -translate-x-1/2"
      />
    </div>
  );
}

/** The questions waiting on the person, on the PM's button. */
function QuestionCount({ n }: { n: number }) {
  return (
    <span
      data-testid="pm-questions"
      aria-label={`${n} ${n === 1 ? "question" : "questions"} for you`}
      className="bg-terracotta-cta text-on-accent absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[9px] leading-none font-bold"
    >
      {n}
    </span>
  );
}

/** The mobile shade's top offset in px (Tailwind top-14). */
const MOBILE_SHADE_TOP = 56;

/** The mobile app bar's way in: a button, and a shade that carries its own composer. */
export function AskButton({
  a,
  repoName,
}: {
  a: AssistantControls;
  repoName: string;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => a.setOpen(!a.open)}
        aria-label={a.open ? "Roll the PM up" : "Ask the PM"}
        aria-expanded={a.open}
        data-tour="chat"
        className="border-line text-ink relative inline-flex size-11 items-center justify-center rounded-[10px] border"
      >
        <SparkIcon />
        {!!a.questions && <QuestionCount n={a.questions} />}
      </button>
      <Shade
        a={a}
        repoName={repoName}
        withComposer
        keyboardTop={MOBILE_SHADE_TOP}
        className="fixed top-14 right-0 left-0"
      />
    </>
  );
}

function ProposalCard({
  p,
  onDecide,
}: {
  p: AssistantMessageView["proposals"][number];
  onDecide: (decision: "apply" | "dismiss") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const decide = async (d: "apply" | "dismiss") => {
    setBusy(true);
    try {
      await onDecide(d);
    } finally {
      setBusy(false);
    }
  };
  const tickets = p.action.tickets ?? [];
  const decided = p.state !== "proposed";
  return (
    <div
      data-state={p.state}
      className={cn(
        "mt-2 rounded-lg border p-3",
        decided ? "border-line/60 bg-column" : "border-line bg-card",
      )}
    >
      <div className={cn(decided && "opacity-60")}>
        <div className="text-ink text-[13px] font-semibold">{p.summary}</div>
        {p.action.type === "create_backlog_item" && p.action.request && (
          <p className="text-muted mt-1 line-clamp-3 text-[12px]">
            {p.action.request}
          </p>
        )}
        {p.action.type === "open_pull_request" && p.action.body && (
          <p className="text-muted mt-1 line-clamp-4 text-[12px] whitespace-pre-line">
            {p.action.body}
          </p>
        )}
        {tickets.length > 0 && (
          <ul className="text-muted mt-1.5 space-y-0.5 text-[12px]">
            {tickets.map((t) => (
              <li key={t.key}>
                <span className="text-ink font-mono text-[11px]">{t.key}</span>{" "}
                {t.title}
                {t.dependsOn.length > 0 && (
                  <span> · after {t.dependsOn.join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        {p.state === "proposed" ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("apply")}
              className="bg-terracotta-cta inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-semibold text-white disabled:opacity-60"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("dismiss")}
              className="text-muted hover:text-ink inline-flex h-8 items-center rounded-lg px-2 text-[12px]"
            >
              Dismiss
            </button>
          </>
        ) : (
          <span
            className={cn(
              "text-[12px] font-medium",
              p.state === "applied" && "text-jade",
              p.state === "dismissed" && "text-muted",
              p.state === "failed" && "text-crimson",
            )}
          >
            {p.state === "applied"
              ? "Approved"
              : p.state === "dismissed"
                ? "Dismissed"
                : `Could not apply: ${p.error ?? "unknown error"}`}
          </span>
        )}
      </div>
    </div>
  );
}

function Message({
  m,
  cli,
  onDecide,
}: {
  m: AssistantMessageView;
  cli: boolean;
  onDecide: (index: number, decision: "apply" | "dismiss") => Promise<void>;
}) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="bg-column text-ink max-w-[80%] rounded-xl rounded-br-sm px-3 py-2 text-[13px] whitespace-pre-wrap">
          {m.content}
        </div>
      </div>
    );
  }
  const speaker =
    m.speaker && m.speaker !== "assistant" ? (m.speaker as GuestId) : null;
  const tagged = (body: React.ReactNode) =>
    speaker ? (
      <div className="flex items-start gap-2.5">
        <GuestCoin id={speaker} />
        <div className="min-w-0">
          <p className="text-muted mb-1 font-mono text-[10px] tracking-[0.08em] uppercase">
            {guestLabel(speaker)}
          </p>
          {body}
        </div>
      </div>
    ) : (
      body
    );
  if (m.status === "pending") {
    return tagged(
      <div
        className="text-muted flex items-center gap-2 text-[13px]"
        role="status"
      >
        <span
          className="bg-clay size-1.5 animate-pulse rounded-full"
          aria-hidden
        />
        {cli
          ? "Working in GitHub Actions. This takes a minute or two."
          : "Thinking…"}
      </div>,
    );
  }
  return tagged(
    <div className="max-w-[92%]">
      <div
        className={cn(
          "text-[13px] leading-[1.55]",
          m.status === "failed"
            ? "text-crimson whitespace-pre-wrap"
            : "text-ink",
        )}
      >
        {m.status === "failed" ? (
          m.content
        ) : (
          <MarkdownLite text={m.content} keepLineBreaks />
        )}
      </div>
      {m.proposals.map((p, i) => (
        <ProposalCard key={i} p={p} onDecide={(d) => onDecide(i, d)} />
      ))}
    </div>,
  );
}

/**
 * The questions agents are waiting on, which the PM relays. Each is answered
 * in its own card's chat, so it opens the card rather than asking the PM.
 */
function WaitingQuestions({ a }: { a: AssistantControls }) {
  const waiting = a.waiting ?? [];
  return (
    <div
      data-testid="pm-waiting"
      className="border-line bg-cream rounded-lg border p-3"
    >
      <p className="text-ink m-0 text-[13px] font-semibold">
        {waiting.length === 1
          ? "A question for you"
          : `${waiting.length} questions for you`}
      </p>
      <p className="text-muted mt-0.5 mb-2 text-[12px]">
        Answer in the card&apos;s chat and its agent carries on.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {waiting.map((q) => (
          <li key={q.id}>
            <button
              type="button"
              onClick={() => {
                a.setOpen(false);
                a.onOpenQuestion?.(q.id);
              }}
              className="border-line bg-card hover:border-terracotta flex w-full flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left"
            >
              <span className="text-muted font-mono text-[10px]">
                {q.key} · {q.title}
              </span>
              <span className="text-ink text-[13px] leading-[1.45]">
                {q.question}
              </span>
              <span className="text-terracotta text-[12px] font-semibold">
                Answer →
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Shade({
  a,
  repoName,
  className,
  withComposer = false,
  keyboardTop,
}: {
  a: AssistantControls;
  repoName: string;
  className?: string;
  withComposer?: boolean;
  /** Top offset in px; when set, the shade shrinks to stay above the on-screen keyboard. */
  keyboardTop?: number;
}) {
  const { visibleHeight } = useKeyboardInset();
  const height = "min(60vh, 620px, calc(100vh - 4rem - 16px))";
  const keyboardHeight =
    keyboardTop !== undefined && visibleHeight !== null
      ? Math.max(0, visibleHeight - keyboardTop)
      : null;
  const list = useRef<HTMLDivElement>(null);
  const selected = a.presets.find((p) => p.id === a.presetId) ?? null;
  const cli = selected
    ? providerInfo(selected.provider)?.kind === "cli"
    : false;

  // Land on the newest message when the panel opens. Not on every streamed
  // update: that would yank the list away from whatever the person is reading.
  useEffect(() => {
    if (a.open)
      list.current?.scrollTo({
        top: list.current.scrollHeight,
        behavior: "smooth",
      });
  }, [a.open]);

  useEffect(() => {
    if (!a.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && a.setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a]);

  return (
    <section
      aria-label="PM"
      data-tour="chat-shade"
      aria-hidden={!a.open}
      inert={!a.open}
      data-open={a.open}
      data-colony-mask={a.open ? "" : undefined}
      className={cn(
        "assistant-shade border-line bg-card z-50 flex flex-col rounded-b-2xl border border-t-0 shadow-[0_18px_40px_-12px_rgba(28,25,23,0.28)]",
        className,
      )}
      style={{
        height:
          keyboardHeight === null
            ? height
            : `min(${height}, ${keyboardHeight}px)`,
      }}
    >
      {a.open && <AutoTour id="chat" delay={500} />}
      <header className="border-hairline flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <div className="w-[240px] max-w-[70%]">
          <AgentSelect
            slot="assistant"
            presets={a.presets}
            selected={selected ?? undefined}
            onAssign={a.setAgent}
            onEdit={a.onEdit}
          />
        </div>
        <CallButton />
        <span className="flex-grow" />
        {a.messages.length > 0 && (
          <button
            type="button"
            onClick={() => void a.clear()}
            disabled={a.pending}
            className="text-muted hover:text-ink text-[12px] disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </header>

      <CallBar />

      <div ref={list} className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {a.messages.length === 0 ? (
          <div className="text-muted mx-auto max-w-[460px] pt-6 text-center text-[13px] leading-[1.6]">
            <p className="text-ink font-serif text-[17px]">
              Ask anything about {repoName}.
            </p>
            <p className="mt-2">
              It reads the repository and the board. It can also add work to the
              board, once you approve it.
            </p>
            <p className="mt-3 font-mono text-[11px]">
              “What does the webhook handler do?” · “Turn docs/tickets.md into
              tickets.”
            </p>
            {!a.presetId && (
              <p className="text-ink mt-4">Choose an agent above to start.</p>
            )}
          </div>
        ) : (
          a.messages.map((m) => (
            <Message
              key={m.id}
              m={m}
              cli={cli}
              onDecide={(i, d) => a.decide(m.id, i, d)}
            />
          ))
        )}
        {!!a.waiting?.length && <WaitingQuestions a={a} />}
        {a.error && (
          <p role="alert" className="text-crimson text-[12px]">
            {a.error}
          </p>
        )}
      </div>

      <footer className="flex shrink-0 items-end gap-2 px-3 pt-1 pb-3">
        {withComposer ? (
          <Composer
            a={a}
            repoName={repoName}
            toggle={false}
            className="flex-1"
          />
        ) : (
          <span className="flex-1" />
        )}
        <button
          type="button"
          onClick={() => a.setOpen(false)}
          aria-label="Roll the PM up"
          title="Roll up"
          className="border-line bg-cream text-ink hover:bg-column inline-flex size-9 items-center justify-center rounded-full border"
        >
          <Chevron up size={14} />
        </button>
      </footer>
    </section>
  );
}
