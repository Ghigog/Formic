"use client";

import type { AssistantControls } from "@/components/board/assistant";
import { guestLabel } from "@/lib/meetings/guests";
import { useCall, useElapsed } from "./call-provider";

/**
 * While the chat is closed, a live call stays in reach: tapping the pill
 * reopens the chat. Bottom centre, above the home bar, clear of the header
 * and the column controls.
 */
export function CallPill({
  assistant,
}: {
  assistant: Pick<AssistantControls, "open" | "setOpen">;
}) {
  const call = useCall();
  const elapsed = useElapsed(call?.startedAt ?? null);
  if (!call?.live || assistant.open) return null;
  return (
    <button
      type="button"
      onClick={() => assistant.setOpen(true)}
      aria-label={`On a call with ${guestLabel("assistant")}, ${elapsed}. Open the chat`}
      className="bg-ink text-cream shadow-lift fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-50 inline-flex h-11 -translate-x-1/2 items-center gap-2 rounded-full px-4 text-[12px] font-medium"
    >
      <span
        className="bg-jade size-2 animate-pulse rounded-full motion-reduce:animate-none"
        aria-hidden
      />
      On a call with {guestLabel("assistant")} ·{" "}
      <span className="font-mono">{elapsed}</span>
    </button>
  );
}
