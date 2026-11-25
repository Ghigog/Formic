"use client";

import { useId, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { Notice } from "@/lib/domain/notice";
import { LinkifiedText } from "./linkified-text";
import { NOTICE_INK, NoticeChevron, NoticeIcon } from "./card";

/** The ground and label each kind of notice is shown with at the top of a drawer. */
export const BANNER: Record<Notice["severity"], { ground: string; label: string }> = {
  warning: { ground: "bg-crimson/10", label: "Warning" },
  alert: { ground: "bg-clay/10", label: "Alert" },
  question: { ground: "bg-plum/10", label: "Question" },
  paused: { ground: "bg-idle/15", label: "Paused" },
};

/**
 * A warning (red), alert (yellow), question (plum) or pause (gray) in full:
 * title, the short line, then the long text. Still: it never pulses.
 */
export function NoticeBanner({
  notice,
  className,
  onOpenChat,
}: {
  notice: Notice;
  className?: string;
  /** Switches to the card's chat; a question links to it as "Answer in the chat". */
  onOpenChat?: () => void;
}) {
  const { ground, label } = BANNER[notice.severity];
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const asking = !!onOpenChat && notice.severity === "question";
  return (
    <div
      role="alert"
      data-severity={notice.severity}
      className={cn("text-ink rounded-md px-2.5 py-2 text-[12px] leading-5", ground, className)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 text-left"
      >
        <NoticeIcon severity={notice.severity} />
        <span className={cn("text-[10px] font-bold uppercase", NOTICE_INK[notice.severity])}>{label}</span>
        <span className="min-w-0 flex-1 font-semibold">{notice.title}</span>
        <NoticeChevron open={open} />
      </button>
      {open && (
        <div id={bodyId}>
          {notice.shortDescription && (
            <p className="mt-1">
              <LinkifiedText text={notice.shortDescription} />
            </p>
          )}
          {notice.longDescription && (
            <pre className="bg-sunken mt-1.5 max-h-40 overflow-auto rounded px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
              <LinkifiedText text={notice.longDescription} />
            </pre>
          )}
          {asking && (
            <button type="button" onClick={onOpenChat} className="text-fg mt-1.5 min-h-9 text-[12px] font-medium underline">
              Answer in the chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}
