"use client";

import { useState } from "react";

/** Which saved agent runs this board's scouts; null follows the column's agent. */
export function ScoutAgentSection({
  projectId,
  presets,
  initial,
}: {
  projectId: string;
  presets: { id: string; name: string }[];
  initial: string | null;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, scoutPresetId: value || null }),
    }).catch(() => null);
    setBusy(false);
    setMessage(res?.ok ? { ok: true, text: "Saved." } : { ok: false, text: "That did not save. Try again." });
  }

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">
        Scout agent
      </h2>
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        The agent that runs scouts on this board. By default scouts use the
        agent of the column they run in.
      </p>
      <div className="flex gap-2">
        <select
          aria-label="Scout agent"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="border-line bg-cream text-ink h-10 min-w-0 flex-1 rounded-md border px-2.5 text-[13px]"
        >
          <option value="">Column&apos;s agent</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="bg-terracotta-cta h-10 rounded-lg px-3.5 text-[13px] font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={`mt-1.5 text-[11px] ${message.ok ? "text-muted" : "text-crimson-text"}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
