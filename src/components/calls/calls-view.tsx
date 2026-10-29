"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** The Calls page: starts an unscheduled call, a meeting that begins now. */
export function CallsView() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    setError(null);
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
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  return (
    <div className="p-4">
      <button
        type="button"
        onClick={() => void start()}
        disabled={starting}
        className="bg-amber text-on-amber rounded px-3 py-1.5 text-[13px] font-medium disabled:opacity-50"
      >
        Start call
      </button>
      {error && (
        <p role="alert" className="text-crimson-text mt-2 text-[12px]">
          {error}
        </p>
      )}
    </div>
  );
}
