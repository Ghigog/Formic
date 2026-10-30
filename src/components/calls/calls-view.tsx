"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GuestId } from "@/lib/calls/guests";
import { useMeetings } from "@/lib/hooks/use-meetings";
import { Calendar, weekStart } from "./calendar";
import { CallsHeader } from "./calls-chrome";
import { MeetingForm } from "./meeting-form";

/** The Calls page: two weeks of slots, the form for the slot picked, and Start call for an unscheduled call. */
export function CallsView({ guests }: { guests: { id: GuestId; label: string }[] }) {
  const router = useRouter();
  const { meetings, error, create } = useMeetings();
  const [from] = useState(() => weekStart(new Date()));
  const [slot, setSlot] = useState<Date | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // An unscheduled call is a meeting that begins now.
  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch("/api/calls/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Call", startsAt: new Date().toISOString(), guests: ["assistant"] }),
      });
      const data = (await res.json().catch(() => null)) as { meeting?: { id: string }; error?: string } | null;
      if (!res.ok || !data?.meeting) throw new Error(data?.error ?? "Could not start the call. Try again.");
      router.push(`/calls/${data.meeting.id}`);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  return (
    <div className="bg-cream min-h-dvh">
      <CallsHeader
        back={{ href: "/", label: "Back to the board" }}
        kicker="The colony"
        title="Calls"
        action={
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting}
            className="bg-terracotta-cta inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M3.6 2.2h2.3l1.2 3-1.6 1.1a8 8 0 0 0 4.2 4.2l1.1-1.6 3 1.2v2.3c0 .7-.6 1.3-1.3 1.3A11.7 11.7 0 0 1 2.3 3.5c0-.7.6-1.3 1.3-1.3Z"
                fill="currentColor"
              />
            </svg>
            {starting ? "Calling…" : "Start call"}
          </button>
        }
      />
      <main className="mx-auto grid max-w-6xl gap-5 px-4 py-6 md:px-6">
        <p className="text-muted max-w-2xl text-[14px] leading-6">
          Meet your colony. Pick a slot to schedule a stand-up, a planning session or a retro; the guests you invite come
          knowing the agenda, and you get a nudge when it starts.
        </p>
        {(error || startError) && (
          <p role="alert" className="bg-crimson/10 text-ink rounded-md px-3 py-2 text-[13px]">
            {error ?? startError}
          </p>
        )}
        <Calendar meetings={meetings} from={from} onPick={setSlot} onOpen={(id) => router.push(`/calls/${id}`)} />
      </main>
      {slot && (
        <MeetingForm
          key={slot.getTime()}
          at={slot}
          guests={guests}
          onCancel={() => setSlot(null)}
          onSave={async (input) => {
            await create(input);
            setSlot(null);
          }}
        />
      )}
    </div>
  );
}
