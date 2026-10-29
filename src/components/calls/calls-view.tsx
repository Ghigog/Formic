"use client";

import { useState } from "react";
import type { GuestId } from "@/lib/calls/guests";
import { useMeetings } from "@/lib/hooks/use-meetings";
import { Calendar, weekStart } from "./calendar";
import { MeetingForm } from "./meeting-form";

/** The Calls page: two weeks of slots, and the form for the slot picked. */
export function CallsView({ guests }: { guests: { id: GuestId; label: string }[] }) {
  const { meetings, error, create } = useMeetings();
  const [from] = useState(() => weekStart(new Date()));
  const [slot, setSlot] = useState<Date | null>(null);

  return (
    <main className="mx-auto grid max-w-6xl gap-4 p-6">
      <h1 className="text-lg font-semibold">Calls</h1>
      {error && <p role="alert">{error}</p>}
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
