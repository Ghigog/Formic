"use client";

import { useCallback, useEffect, useState } from "react";
import type { Meeting, MeetingRepeat } from "@/lib/db/repository";
import type { GuestId } from "@/lib/meetings/guests";

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

const CHANGED = "formic:meetings-changed";
const announce = () => window.dispatchEvent(new Event(CHANGED));

/** The active board's meetings, and scheduling a new one. */
export function useMeetings() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/meetings")
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load the meetings.");
        return (await res.json()) as { meetings: MeetingJson[] };
      })
      .then((data) => live && setMeetings(data.meetings.map(parse)))
      .catch((e: Error) => live && setError(e.message));
    load();
    // Every user of the hook reloads when one of them changes a meeting.
    window.addEventListener(CHANGED, load);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, load);
    };
  }, []);

  /** Saves a meeting; throws with the server's message when it refuses. */
  const create = useCallback(async (input: MeetingInput) => {
    await send("/api/meetings", "POST", input);
    announce();
  }, []);

  const update = useCallback(async (id: string, input: MeetingInput) => {
    await send(`/api/meetings/${id}`, "PATCH", input);
    announce();
  }, []);

  const remove = useCallback(async (id: string) => {
    const res = await fetch(`/api/meetings/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Could not delete the meeting. Try again.");
    announce();
  }, []);

  return { meetings, error, create, update, remove };
}

async function send(url: string, method: string, input: MeetingInput) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, startsAt: input.startsAt.toISOString() }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? "That did not save. Try again.");
  }
}
