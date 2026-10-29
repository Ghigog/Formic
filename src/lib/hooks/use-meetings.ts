"use client";

import { useCallback, useEffect, useState } from "react";
import type { Meeting, MeetingRepeat } from "@/lib/db/repository";
import type { GuestId } from "@/lib/calls/guests";

export interface MeetingInput {
  title: string;
  startsAt: Date;
  agenda: string;
  guests: GuestId[];
  repeat: MeetingRepeat;
}

type MeetingJson = Omit<Meeting, "startsAt" | "lastRemindedFor" | "createdAt"> & {
  startsAt: string;
  lastRemindedFor: string | null;
  createdAt: string;
};

const parse = (m: MeetingJson): Meeting => ({
  ...m,
  startsAt: new Date(m.startsAt),
  lastRemindedFor: m.lastRemindedFor ? new Date(m.lastRemindedFor) : null,
  createdAt: new Date(m.createdAt),
});

/** The active board's meetings, and scheduling a new one. */
export function useMeetings() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/calls/meetings")
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load the meetings.");
        return (await res.json()) as { meetings: MeetingJson[] };
      })
      .then((data) => live && setMeetings(data.meetings.map(parse)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);

  /** Saves a meeting; throws with the server's message when it refuses. */
  const create = useCallback(async (input: MeetingInput) => {
    const res = await fetch("/api/calls/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, startsAt: input.startsAt.toISOString() }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? "That did not save. Try again.");
    }
    const { meeting } = (await res.json()) as { meeting: MeetingJson };
    setMeetings((all) => [...all, parse(meeting)]);
  }, []);

  return { meetings, error, create };
}
