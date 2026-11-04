"use client";

import { useState } from "react";
import { GuestCoin } from "@/components/meetings/guest-coin";
import { cn } from "@/components/ui/cn";
import { guestLabel } from "@/lib/meetings/guests";
import { useCall, useElapsed, type MicState } from "./call-provider";

const MIC_LABEL: Record<MicState, string> = {
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  muted: "Muted",
};

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      {muted && (
        <path
          d="M4 4l16 16"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/** The add button: picks someone from the guests not yet on the call. */
function AddGuest() {
  const call = useCall();
  const [open, setOpen] = useState(false);
  if (!call) return null;
  const left = call.options.filter((o) => !call.guests.includes(o.id));
  if (left.length === 0) return null;
  return (
    <span className="relative">
      <button
        type="button"
        aria-label="Add someone to the call"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="border-line bg-card text-ink hover:bg-column inline-flex size-8 items-center justify-center rounded-full border text-[16px] leading-none md:size-6"
      >
        +
      </button>
      {open && (
        <ul
          role="menu"
          className="border-line bg-card shadow-lift absolute top-full left-0 z-10 mt-1 max-h-60 w-44 overflow-y-auto rounded-lg border p-1"
        >
          {left.map((o) => (
            <li key={o.id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  call.addGuest(o.id);
                  setOpen(false);
                }}
                className="text-ink hover:bg-column flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] md:min-h-8"
              >
                <GuestCoin id={o.id} size={20} />
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/** Who is on the call, how long, and the mic: sits at the top of the PM chat. */
export function CallBar() {
  const call = useCall();
  const elapsed = useElapsed(call?.startedAt ?? null);
  if (!call?.live) return null;
  const label = MIC_LABEL[call.mic];
  return (
    <div
      data-tour="call-bar"
      className="border-hairline bg-cream flex shrink-0 items-center gap-3 border-b px-4 py-2.5"
    >
      <span
        data-testid="call-mic"
        data-state={call.mic}
        role="status"
        aria-label={label}
        className={cn(
          "inline-flex size-11 shrink-0 items-center justify-center rounded-full",
          call.mic === "muted"
            ? "bg-column text-muted"
            : "bg-terracotta-cta text-on-accent",
          call.mic === "listening" &&
            "animate-pulse motion-reduce:animate-none",
        )}
      >
        <MicIcon muted={call.mic === "muted"} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5" role="list" aria-label="On the call">
          {call.guests.map((g) => (
            <span
              key={g}
              role="listitem"
              title={guestLabel(g)}
              data-testid={`call-guest-${g}`}
              data-active={call.active === g}
              className={cn(
                "rounded-full p-0.5 transition-shadow",
                call.active === g && "ring-terracotta-cta ring-2",
              )}
            >
              <GuestCoin id={g} size={24} />
            </span>
          ))}
          <AddGuest />
        </div>
        <p className="text-ink m-0 truncate text-[13px] font-semibold">
          On a call with {call.guests.map(guestLabel).join(", ")}
        </p>
        <p className="text-muted m-0 font-mono text-[11px]">
          <span data-testid="call-elapsed">{elapsed}</span> · {label}
        </p>
      </div>
      <button
        type="button"
        onClick={() => call.setMuted(!call.muted)}
        aria-pressed={call.muted}
        className="border-line bg-card text-ink hover:bg-column inline-flex h-11 items-center rounded-lg border px-3 text-[12px] font-medium md:h-8"
      >
        {call.muted ? "Unmute" : "Mute"}
      </button>
      <button
        type="button"
        onClick={call.hangUp}
        className="bg-crimson inline-flex h-11 items-center rounded-lg px-3 text-[12px] font-semibold text-white md:h-8"
      >
        Hang up
      </button>
    </div>
  );
}
