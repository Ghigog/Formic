"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { cn } from "@/components/ui/cn";
import type { AgentPreset } from "@/lib/domain/entities";
import type { AssistantMessageView } from "@/lib/hooks/use-assistant";
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
  ask: (text: string) => Promise<void>;
  clear: () => Promise<void>;
  decide: (
    messageId: string,
    index: number,
    decision: "apply" | "dismiss",
  ) => Promise<void>;
  setAgent: (presetId: string | null) => Promise<void>;
  presets: AgentPreset[];
  onNewAgent: () => void;
  onEditAgent: (preset: AgentPreset) => void;
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
  const [text, setText] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || a.pending) return;
    a.setOpen(true);
    setText("");
    await a.ask(value);
    onAsked?.();
  };
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className={cn("relative flex items-center", className)}
    >
      <span className="text-muted pointer-events-none absolute left-3">
        <SparkIcon />
      </span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => a.messages.length > 0 && a.setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && a.setOpen(false)}
        placeholder={a.pending ? "Answering…" : `Ask about ${repoName}…`}
        aria-label="Ask the assistant"
        className={cn(
          "border-line bg-cream text-ink placeholder:text-muted h-9 w-full rounded-lg border pl-9 text-[13px] outline-none focus:border-terracotta",
          toggle ? "pr-10" : "pr-3",
        )}
      />
      {toggle && (
        <button
          type="button"
          onClick={() => a.setOpen(!a.open)}
          aria-label={
            a.open ? "Roll the assistant up" : "Pull the assistant down"
          }
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
    <div className="relative w-full max-w-[520px]">
      <Composer a={a} repoName={repoName} />
      <Shade
        a={a}
        repoName={repoName}
        className="absolute top-[calc(100%+14px)] left-1/2 w-[min(920px,calc(100vw-48px))] -translate-x-1/2"
      />
    </div>
  );
}

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
        aria-label={a.open ? "Roll the assistant up" : "Ask the assistant"}
        aria-expanded={a.open}
        className="border-line text-ink inline-flex size-11 items-center justify-center rounded-[10px] border"
      >
        <SparkIcon />
      </button>
      <Shade
        a={a}
        repoName={repoName}
        withComposer
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
  return (
    <div className="border-line bg-card mt-2 rounded-lg border p-3">
      <div className="text-ink text-[13px] font-semibold">{p.summary}</div>
      {p.action.type === "create_backlog_item" && p.action.request && (
        <p className="text-muted mt-1 line-clamp-3 text-[12px]">
          {p.action.request}
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
      <div className="mt-2.5 flex items-center gap-2">
        {p.state === "proposed" ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("apply")}
              className="bg-terracotta-cta inline-flex h-8 items-center rounded-md px-3 text-[12px] font-semibold text-white disabled:opacity-60"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("dismiss")}
              className="text-muted hover:text-ink inline-flex h-8 items-center rounded-md px-2 text-[12px]"
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
  if (m.status === "pending") {
    return (
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
      </div>
    );
  }
  return (
    <div className="max-w-[92%]">
      <div
        className={cn(
          "text-[13px] leading-[1.55] whitespace-pre-wrap",
          m.status === "failed" ? "text-crimson" : "text-ink",
        )}
      >
        {m.content}
      </div>
      {m.proposals.map((p, i) => (
        <ProposalCard key={i} p={p} onDecide={(d) => onDecide(i, d)} />
      ))}
    </div>
  );
}

function Shade({
  a,
  repoName,
  className,
  withComposer = false,
}: {
  a: AssistantControls;
  repoName: string;
  className?: string;
  withComposer?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  const selected = a.presets.find((p) => p.id === a.presetId) ?? null;
  const cli = selected
    ? providerInfo(selected.provider)?.kind === "cli"
    : false;

  // Newest at the bottom, where the eye already is.
  useEffect(() => {
    if (a.open)
      list.current?.scrollTo({
        top: list.current.scrollHeight,
        behavior: "smooth",
      });
  }, [a.open, a.messages]);

  useEffect(() => {
    if (!a.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && a.setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [a]);

  return (
    <section
      aria-label="Assistant"
      aria-hidden={!a.open}
      inert={!a.open}
      data-open={a.open}
      className={cn(
        "assistant-shade border-line bg-card z-30 flex flex-col rounded-b-2xl border border-t-0 shadow-[0_18px_40px_-12px_rgba(28,25,23,0.28)]",
        className,
      )}
      style={{ height: "min(60vh, 620px)" }}
    >
      <header className="border-hairline flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <span className="text-muted text-[11px] font-semibold tracking-[0.06em] uppercase">
          Runs on
        </span>
        <select
          value={a.presetId ?? ""}
          onChange={(e) => void a.setAgent(e.target.value || null)}
          aria-label="The assistant's agent"
          className="border-line bg-cream text-ink h-8 max-w-[220px] rounded-md border px-2 text-[12px]"
        >
          <option value="">Choose an agent</option>
          {a.presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ·{" "}
              {(providerInfo(p.provider)?.label ?? p.provider).split(" (")[0]}
            </option>
          ))}
        </select>
        {selected ? (
          <button
            type="button"
            onClick={() => a.onEditAgent(selected)}
            className="text-muted hover:text-ink text-[12px] underline-offset-2 hover:underline"
          >
            Edit
          </button>
        ) : null}
        <button
          type="button"
          onClick={a.onNewAgent}
          className="text-muted hover:text-ink text-[12px] underline-offset-2 hover:underline"
        >
          New agent
        </button>
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
          aria-label="Roll the assistant up"
          title="Roll up"
          className="border-line bg-cream text-ink hover:bg-column inline-flex size-9 items-center justify-center rounded-full border"
        >
          <Chevron up size={14} />
        </button>
      </footer>
    </section>
  );
}
