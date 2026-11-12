"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardCard } from "@/lib/domain/entities";
import { MarkdownLite } from "@/components/ui/markdown-lite";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { useColony } from "./colony";

type Findings =
  | { found: true; markdown: string; epicId: string | null }
  | { found: false; prUrl: string | null; epicId: string | null };

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; findings: Findings };

/**
 * Splits the section whose heading starts with "Recommendation" off the
 * document, so it can stand apart. It runs to the next heading of the same
 * or a higher level.
 */
export function splitRecommendation(markdown: string): { rest: string; recommendation: string | null } {
  const lines = markdown.split("\n");
  let fence = false;
  let from = -1;
  let level = 0;
  let to = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, hashes = "", title = ""] = m;
    if (from < 0) {
      if (/^recommendation/i.test(title.trim())) {
        from = i;
        level = hashes.length;
      }
    } else if (hashes.length <= level) {
      to = i;
      break;
    }
  }
  if (from < 0) return { rest: markdown, recommendation: null };
  return {
    rest: [...lines.slice(0, from), ...lines.slice(to)].join("\n").trim(),
    recommendation: lines.slice(from, to).join("\n").trim(),
  };
}

/** A spike merged: its findings, well formatted, and one step to make a PRD from them. */
export function SpikeFindingsDialog({
  ticket,
  branch,
  onClose,
  onOpenEpic,
}: {
  ticket: Pick<BoardCard, "id" | "key" | "title">;
  /** The board's branch the findings are read from, for the "not found" note. */
  branch?: string;
  onClose: () => void;
  onOpenEpic: (epicId: string) => void;
}) {
  const c = useColony();
  const sfx = c?.sfx;
  const reduced = !!c?.fx.reducedMotion;
  const backdrop = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [epicId, setEpicId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const fetchFindings = useCallback(
    async (signal?: AbortSignal) => {
      setLoad({ state: "loading" });
      try {
        const res = await fetch(`/api/tickets/${ticket.id}/findings`, { signal });
        if (!res.ok) throw new Error(String(res.status));
        const findings = (await res.json()) as Findings;
        setEpicId(findings.epicId ?? null);
        setLoad({ state: "ready", findings });
      } catch {
        if (!signal?.aborted) setLoad({ state: "error" });
      }
    },
    [ticket.id],
  );

  useEffect(() => {
    const ctl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchFindings(ctl.signal);
    return () => ctl.abort();
  }, [fetchFindings]);

  useEffect(() => {
    sfx?.("coin");
    backdrop.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
    if (!reduced) {
      card.current?.animate?.(
        [
          { opacity: 0, transform: "translateY(12px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 320, easing: "ease-out" },
      );
    }
    card.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    sfx?.("close");
    onClose();
  };
  const trap = useFocusTrap({ onEscape: close });

  const make = async () => {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}/findings/epic`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const { card: epic } = (await res.json()) as { card: { id: string } };
      setEpicId(epic.id);
      sfx?.("click");
      onOpenEpic(epic.id);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  const found = load.state === "ready" && load.findings.found;
  const parts = load.state === "ready" && load.findings.found ? splitRecommendation(load.findings.markdown) : null;
  const prose = "text-ink font-serif text-[15px] leading-relaxed [&_h1]:text-[22px] [&_h2]:text-[18px] [&_h3]:text-[15px]";

  return (
    <div
      ref={backdrop}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-0 z-[80] flex items-end justify-center bg-[color-mix(in_srgb,var(--anthracite)_38%,transparent)] backdrop-blur-md sm:items-center sm:p-4"
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={card}
        role="dialog"
        aria-modal
        tabIndex={-1}
        onKeyDown={trap}
        aria-labelledby="spike-findings-title"
        className="bg-card box-border flex h-[92dvh] w-full flex-col gap-3.5 overflow-hidden rounded-t-xl px-5 pt-6 pb-4 shadow-[0_40px_80px_-24px_color-mix(in_srgb,var(--anthracite)_50%,transparent)] sm:h-auto sm:max-h-[calc(100dvh-32px)] sm:w-[640px] sm:max-w-full sm:rounded-xl sm:px-8 sm:pt-8 sm:pb-6"
      >
        <div className="flex flex-col items-start gap-2">
          <span className="oct bg-jade inline-flex p-px">
            <span className="oct bg-jade-chip text-jade-chip-text inline-flex px-2 py-0.5 font-mono text-[10px] tracking-[0.1em]">
              SPIKE COMPLETE · {ticket.key}
            </span>
          </span>
          <h2 id="spike-findings-title" className="text-ink m-0 font-serif text-[18px] leading-[1.2] font-semibold">
            {ticket.title}
          </h2>
        </div>

        <div className="border-line min-h-0 flex-1 overflow-y-auto border-y py-4">
          {load.state === "loading" && (
            <div role="status" aria-label="Loading findings" className="flex flex-col gap-2.5">
              {["w-1/3", "w-full", "w-11/12", "w-4/5", "w-full", "w-2/3"].map((w, i) => (
                <span key={i} className={`bg-line block h-3 rounded-sm motion-safe:animate-pulse ${w}`} />
              ))}
            </div>
          )}
          {load.state === "error" && (
            <div role="alert" className="flex flex-col items-start gap-3">
              <p className="text-ink m-0 text-[13px]">The findings could not be loaded.</p>
              <button
                type="button"
                onClick={() => void fetchFindings()}
                className="border-line text-ink h-9 cursor-pointer rounded-lg border px-3 text-[13px] font-semibold"
              >
                Try again
              </button>
            </div>
          )}
          {load.state === "ready" && !load.findings.found && (
            <p className="text-ink m-0 text-[13px] leading-relaxed">
              The findings could not be found on {branch ?? "the board's branch"}.
              {load.findings.prUrl && (
                <>
                  {" "}
                  <a
                    href={load.findings.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-cta font-semibold underline"
                  >
                    Open the pull request
                  </a>
                </>
              )}
            </p>
          )}
          {parts && (
            <div className="flex flex-col gap-4">
              {parts.rest && <MarkdownLite text={parts.rest} className={prose} />}
              {parts.recommendation && (
                <section
                  aria-label="Recommendation"
                  className="bg-jade-chip rounded-lg p-4"
                >
                  <MarkdownLite text={parts.recommendation} className={prose} />
                </section>
              )}
            </div>
          )}
        </div>

        {failed && (
          <p role="alert" className="text-ink m-0 text-[12px]">
            The Epic could not be made. Try again.
          </p>
        )}
        <div className="flex w-full gap-2">
          {(found || epicId) && (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (epicId) {
                  sfx?.("click");
                  onOpenEpic(epicId);
                } else void make();
              }}
              className="bg-cta inline-flex h-10 flex-1 cursor-pointer items-center justify-center rounded-lg text-[13px] font-semibold text-white transition-transform hover:-translate-y-px active:translate-y-px disabled:cursor-wait disabled:opacity-70"
            >
              {epicId ? "Open Epic" : pending ? "Making the PRD…" : "Make a PRD from these findings"}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="border-line text-ink h-10 cursor-pointer rounded-lg border px-4 text-[13px] font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
