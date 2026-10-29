"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { GuestId } from "@/lib/calls/guests";
import { useMeetings } from "@/lib/hooks/use-meetings";
import { Calendar, weekStart } from "./calendar";
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
    <main className="mx-auto grid max-w-6xl gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Calls</h1>
        <button
          type="button"
          onClick={() => void start()}
          disabled={starting}
          className="bg-amber text-on-amber rounded px-3 py-1.5 text-[13px] font-medium disabled:opacity-50"
        >
          Start call
        </button>
      </div>
      {(error || startError) && <p role="alert">{error ?? startError}</p>}
      <Calendar meetings={meetings} from={from} onPick={setSlot} />
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
    </main>
  );
}
