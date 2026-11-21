"use client";

import { AutoTour } from "@/components/onboarding/tour";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AgentSelect } from "./agent-select";
import { EarlierMessages, useKeepPlace } from "./earlier-messages";
import { useDraft } from "./use-draft";
import { pastedFileName } from "./attachment-picker";
import {
  DraftImages,
  IMAGE_TYPES,
  PaperclipIcon,
  SentImages,
  useComposerImages,
} from "./composer-images";
import { cn } from "@/components/ui/cn";
import { MarkdownLite } from "@/components/ui/markdown-lite";
import { GuestCoin } from "@/components/board/guest-coin";
import { guestLabel, type GuestId } from "@/lib/assistant/guest-ids";
import { kindOf, threadOrder } from "@/lib/domain/chat";
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
  /** The board's identity; each board keeps its own unsent draft. */
  boardId: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  presetId: string | null;
  messages: AssistantMessageView[];
  /** Whether the thread has messages before the ones loaded. */
  hasEarlier?: boolean;
  loadingEarlier?: boolean;
  earlierError?: string | null;
  loadEarlier?: () => Promise<void>;
  pending: boolean;
  error: string | null;
  /** Sends a message; `speakers` are who answers it, in order (the PM by default), `requestId` the draft its images were uploaded under. */
  ask: (text: string, speakers?: string[], requestId?: string) => Promise<void>;
  /** Stops one pending reply: only an explicit Stop does. */
  stop: (messageId: string) => void;
  clear: () => Promise<void>;
  decide: (
    messageId: string,
    index: number,
    decision: "apply" | "dismiss",
  ) => Promise<void>;
  setAgent: (presetId: string | null) => Promise<void>;
  presets: AgentPreset[];
  /** How many cards are waiting on a question for the person, which the PM relays. */
  questions?: number;
  /** The questions themselves, shown at the bottom of the PM's chat, after the newest message; each opens its card, where it is answered. */
  waiting?: Array<{ id: string; key: string; title: string; question: string }>;
  onOpenQuestion?: (cardId: string) => void;
  /** How many PM messages the person has not read yet; the PM's button shows it until they open the chat. */
  unread?: number;
  /** When the person last read the chat (ISO), as of opening it: the "New" rule sits above the first PM message after it. */
  readAt?: string | null;
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
  const [text, setText] = useDraft(`assistant:${a.boardId}`);
  const field = useRef<HTMLTextAreaElement>(null);
  const images = useComposerImages();
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if ((!value && !images.hasImages) || images.uploading) return;
    const withImages = images.hasImages ? images.requestId : null;
    a.setOpen(true);
    setText("");
    images.reset();
    await (withImages ? a.ask(value, undefined, withImages) : a.ask(value));
    onAsked?.();
  };
  // A screenshot on the clipboard becomes an attachment; plain text pastes as usual.
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file)
        files.push(
          new File([file], pastedFileName(file.type || "image/png"), {
            type: file.type,
          }),
        );
    }
    if (files.length === 0) return;
    e.preventDefault();
    images.add(files);
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
      className={cn("relative flex flex-col", className)}
    >
      {(images.items.length > 0 || images.error) && (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1",
            // The bar has no room above the box, so its row hangs below it.
            toggle
              ? "border-line bg-cream absolute top-full right-0 left-0 z-10 mt-1.5 rounded-lg border p-2"
              : "pb-1.5",
          )}
        >
          <DraftImages images={images} />
          {images.error && (
            <p role="alert" className="text-muted text-[12px]">
              {images.error}
            </p>
          )}
        </div>
      )}
      <div className="relative flex items-center">
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
          onPaste={onPaste}
          placeholder={
            a.pending
              ? "Answering… you can keep typing"
              : a.questions
                ? `The PM has ${a.questions === 1 ? "a question" : `${a.questions} questions`} for you…`
                : `Ask the PM about ${repoName}…`
          }
          aria-label="Ask the PM"
          className={cn(
            "border-line bg-cream text-ink placeholder:text-muted h-9 w-full resize-none rounded-lg border py-1.75 pl-9 text-[13px] leading-5 outline-none [scrollbar-width:none] focus:border-terracotta [&::-webkit-scrollbar]:hidden",
            toggle ? "pr-26" : "pr-18",
          )}
        />
        <label
          className={cn(
            "text-muted hover:text-ink absolute inline-flex size-8 cursor-pointer items-center justify-center rounded-md focus-within:outline-2",
            toggle ? "right-17" : "right-9",
          )}
          title="Attach an image"
        >
          <PaperclipIcon />
          <input
            type="file"
            multiple
            accept={IMAGE_TYPES.join(",")}
            aria-label="Attach an image"
            className="sr-only"
            onChange={(e) => {
              images.add(e.target.files ?? []);
              e.target.value = "";
            }}
          />
        </label>
        {/* Always Send: a Stop here would sit under the pointer the moment a
            message goes, and a second click would stop the answer. Stop is on
            the pending reply itself. */}
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
      </div>
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
      <UnreadCount n={a.unread ?? 0} withQuestions={false} />
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
      className="bg-cta text-on-accent absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] leading-none font-bold"
    >
      {n}
    </span>
  );
}

/**
 * The PM's messages the person has not read, on its button. It pops in once
 * when the count goes from none to some; after that it just changes.
 */
function UnreadCount({
  n,
  withQuestions,
}: {
  n: number;
  withQuestions: boolean;
}) {
  const [prev, setPrev] = useState(n);
  const [pop, setPop] = useState(false);
  if (prev !== n) {
    setPrev(n);
    setPop(prev === 0 && n > 0);
  }
  if (!n) return null;
  return (
    <span
      data-testid="pm-unread"
      aria-label={`${n} new ${n === 1 ? "message" : "messages"} from the PM`}
      className={cn(
        "bg-cta text-on-accent absolute -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[10px] leading-none font-bold",
        withQuestions ? "-left-1" : "-right-1",
        pop && "pm-badge-pop",
      )}
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
        className="border-line text-ink relative inline-flex size-11 items-center justify-center rounded-lg border"
      >
        <SparkIcon />
        {!!a.questions && <QuestionCount n={a.questions} />}
        <UnreadCount n={a.unread ?? 0} withQuestions={!!a.questions} />
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

export function ProposalCard({
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
        {(p.action.type === "create_backlog_item" ||
          p.action.type === "create_todo_item") &&
          p.action.request && (
          <p className="text-muted mt-1 line-clamp-3 text-[12px]">
            {p.action.request}
          </p>
        )}
        {p.action.type === "open_pull_request" && p.action.body && (
          <p className="text-muted mt-1 line-clamp-4 text-[12px] whitespace-pre-line">
            {p.action.body}
          </p>
        )}
        {p.action.type === "revise_rubric_check" &&
          (p.action.current || p.action.proposed) && (
            <div className="mt-1.5 space-y-1.5 text-[12px]">
              {p.action.current && (
                <p className="text-muted font-mono text-[11px] break-words whitespace-pre-line">
                  {p.action.current}
                </p>
              )}
              {p.action.proposed && (
                <p className="text-ink font-mono text-[11px] break-words whitespace-pre-line">
                  {p.action.proposed}
                </p>
              )}
            </div>
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
              className="bg-cta inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-semibold text-white disabled:opacity-60"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("dismiss")}
              className="text-muted hover:text-ink inline-flex h-8 items-center rounded-lg px-2 text-[12px]"
            >
              {p.action.type === "revise_rubric_check" ? "Decline" : "Dismiss"}
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
                ? p.action.type === "revise_rubric_check"
                  ? "Declined"
                  : "Dismissed"
                : `Could not apply: ${p.error ?? "unknown error"}`}
          </span>
        )}
      </div>
    </div>
  );
}

/** Copies a message's raw Markdown, and says so for a moment. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard API (an http page, an old browser): the textarea way.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy"}
      className="text-muted hover:text-ink hover:bg-column inline-flex size-8 shrink-0 items-center justify-center rounded-md md:size-6"
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <rect x="3.75" y="3.75" width="6.5" height="6.5" rx="1.25" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8.25 2.25V2A1.25 1.25 0 0 0 7 .75H3A1.25 1.25 0 0 0 1.75 2v4A1.25 1.25 0 0 0 3 7.25h.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function CardLinks({
  cards,
  onOpenCard,
}: {
  cards: NonNullable<AssistantMessageView["cards"]>;
  onOpenCard: (cardId: string) => void;
}) {
  return (
    <ul
      data-testid="pm-cards"
      className="m-0 mt-2 flex list-none flex-wrap gap-1.5 p-0"
    >
      {cards.map((c) => (
        <li key={c.id} className="max-w-full">
          <button
            type="button"
            onClick={() => onOpenCard(c.id)}
            className="border-line bg-card hover:border-terracotta text-muted inline-flex min-h-11 max-w-full items-center rounded-md border px-2.5 text-left font-mono text-[10px] md:min-h-8"
          >
            <span className="truncate">
              {c.key} · {c.title}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Formic's own word on the board, as a timeline line: an icon, its first
 * line, the rest behind More, its cards and anything it asks the person to
 * decide. Never a PM bubble: the PM did not say it.
 */
function Notice({
  m,
  onDecide,
  onOpenCard,
}: {
  m: AssistantMessageView;
  onDecide: (index: number, decision: "apply" | "dismiss") => Promise<void>;
  onOpenCard: (cardId: string) => void;
}) {
  const [head = "", ...rest] = m.content.trim().split("\n");
  const more = rest.join("\n").trim();
  return (
    <div
      data-kind="notice"
      role="note"
      className="border-hairline flex items-start gap-2 border-l-2 py-0.5 pl-2.5"
    >
      <span className="text-clay mt-1 shrink-0" aria-hidden>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <circle cx="5" cy="5" r="3" fill="currentColor" />
        </svg>
      </span>
      <div className="text-muted min-w-0 flex-1 text-[12px] leading-[1.5]">
        <MarkdownLite text={head} />
        {more && (
          <details className="mt-0.5">
            <summary className="hover:text-ink w-fit cursor-pointer select-none text-[11px]">
              More
            </summary>
            <MarkdownLite text={more} keepLineBreaks className="mt-1" />
          </details>
        )}
        {!!m.cards?.length && <CardLinks cards={m.cards} onOpenCard={onOpenCard} />}
        {m.proposals.map((p, i) => (
          <ProposalCard key={i} p={p} onDecide={(d) => onDecide(i, d)} />
        ))}
      </div>
      <CopyButton text={m.content} />
    </div>
  );
}

function Message({
  m,
  cli,
  onDecide,
  onOpenCard,
  onStop,
}: {
  m: AssistantMessageView;
  cli: boolean;
  onDecide: (index: number, decision: "apply" | "dismiss") => Promise<void>;
  onOpenCard: (cardId: string) => void;
  onStop: () => void;
}) {
  const kind = kindOf(m);
  if (kind === "notice") {
    return <Notice m={m} onDecide={onDecide} onOpenCard={onOpenCard} />;
  }
  if (kind === "person") {
    return (
      <div data-kind="person" className="flex justify-end">
        <div className="flex max-w-[80%] flex-col items-end">
          {!!m.attachments?.length && <SentImages images={m.attachments} />}
          {m.content && (
            <div className="bg-column text-ink rounded-xl rounded-br-sm px-3 py-2 text-[13px] whitespace-pre-wrap">
              {m.content}
            </div>
          )}
          {m.content && <CopyButton text={m.content} />}
        </div>
      </div>
    );
  }
  const speaker =
    kind === "guest" && m.speaker ? (m.speaker as GuestId) : null;
  const tagged = (body: React.ReactNode) =>
    speaker ? (
      <div data-kind="guest" className="flex items-start gap-2.5">
        <GuestCoin id={speaker} />
        <div className="min-w-0">
          <p className="text-muted mb-1 font-mono text-[10px] tracking-[0.08em] uppercase">
            {guestLabel(speaker)}
          </p>
          {body}
        </div>
      </div>
    ) : (
      <div data-kind="pm">{body}</div>
    );
  if (m.status === "pending") {
    return tagged(
      <div className="text-muted flex items-center gap-2 text-[13px]">
        <span role="status" className="flex items-center gap-2">
          <span
            className="bg-clay size-1.5 animate-pulse rounded-full"
            aria-hidden
          />
          {cli
            ? "Working in your repository's CI. This takes a minute or two."
            : "Thinking…"}
        </span>
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop"
          title="Stop this answer"
          className="text-ink hover:bg-column inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-[12px] md:min-h-7"
        >
          <span className="bg-ink size-2 rounded-sm" aria-hidden />
          Stop
        </button>
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
      {!!m.cards?.length && <CardLinks cards={m.cards} onOpenCard={onOpenCard} />}
      {m.proposals.map((p, i) => (
        <ProposalCard key={i} p={p} onDecide={(d) => onDecide(i, d)} />
      ))}
      {m.content && (
        <div className="-ml-1.5 mt-0.5">
          <CopyButton text={m.content} />
        </div>
      )}
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

/** Above the first message the person has not read. */
function NewRule() {
  return (
    <div
      data-testid="pm-new"
      role="separator"
      className="text-clay flex items-center gap-2 font-mono text-[10px] tracking-[0.08em] uppercase"
    >
      <span className="border-clay flex-1 border-t" />
      New
      <span className="border-clay flex-1 border-t" aria-hidden />
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
  const { list, keepPlace } = useKeepPlace(a.messages[0]?.id);
  const selected = a.presets.find((p) => p.id === a.presetId) ?? null;
  const cli = selected
    ? providerInfo(selected.provider)?.kind === "cli"
    : false;

  // A reply always sits directly under the message it answers.
  const thread = useMemo(() => threadOrder(a.messages), [a.messages]);
  // The first PM message written after the person last read the chat.
  const firstNew = thread.find(
    (m) =>
      m.role === "assistant" &&
      m.status !== "pending" &&
      (!a.readAt || (m.createdAt ?? "") > a.readAt),
  )?.id;

  // Land on the newest message when the panel opens. Not on every streamed
  // update: that would yank the list away from whatever the person is reading.
  useEffect(() => {
    if (a.open)
      list.current?.scrollTo({
        top: list.current.scrollHeight,
        behavior: "smooth",
      });
  }, [a.open, list]);

  // While a drag that began in the thread is in progress, everything else is
  // unselectable (globals.css), so the browser keeps the selection inside the
  // thread and keeps auto-scrolling it. Ending the drag only removes the
  // attribute; the selection already made stays, so Copy still works.
  useEffect(() => {
    const root = document.documentElement;
    const end = () => root.removeAttribute("data-pm-selecting");
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      end();
    };
  }, []);

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
        "assistant-shade border-line bg-card z-50 flex flex-col rounded-b-xl border border-t-0 shadow-[0_18px_40px_-12px_rgba(28,25,23,0.28)]",
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
      <header className="border-hairline flex select-none shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <div className="w-[240px] max-w-[70%]">
          <AgentSelect
            slot="assistant"
            presets={a.presets}
            selected={selected ?? undefined}
            onAssign={a.setAgent}
            onEdit={a.onEdit}
          />
        </div>
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

      <div
        ref={list}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if ((e.target as Element).closest("button, a, input, textarea"))
            return;
          document.documentElement.setAttribute("data-pm-selecting", "");
        }}
        className="pm-thread flex-1 space-y-4 overflow-y-auto px-5 py-4"
      >
        {a.messages.length === 0 ? (
          <div className="text-muted mx-auto max-w-[460px] pt-6 text-center text-[13px] leading-[1.6]">
            <p className="text-ink font-serif text-[15px]">
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
          <>
            {a.hasEarlier && a.loadEarlier && (
              <EarlierMessages
                loading={!!a.loadingEarlier}
                error={a.earlierError ?? null}
                onLoad={() => void keepPlace(a.loadEarlier!)}
              />
            )}
            {thread.map((m) => (
              <Fragment key={m.id}>
                {m.id === firstNew && <NewRule />}
                <Message
                  m={m}
                  cli={cli}
                  onStop={() => a.stop(m.id)}
                  onDecide={(i, d) => a.decide(m.id, i, d)}
                  onOpenCard={(id) => {
                    a.setOpen(false);
                    a.onOpenQuestion?.(id);
                  }}
                />
              </Fragment>
            ))}
          </>
        )}
        {!!a.waiting?.length && <WaitingQuestions a={a} />}
        {a.error && (
          <p role="alert" className="text-crimson text-[12px]">
            {a.error}
          </p>
        )}
      </div>

      <footer className="flex shrink-0 items-end select-none gap-2 px-3 pt-1 pb-3">
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
