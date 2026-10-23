"use client";

import { useEffect, useState } from "react";
import type { PushPreferences } from "@/lib/db/repository";

const KINDS: { key: keyof PushPreferences; label: string }[] = [
  { key: "ticketMoved", label: "Ticket moved" },
  { key: "epicCompleted", label: "Epic completed" },
  { key: "needsAttention", label: "Ticket needs attention" },
];

const ALL_ON: PushPreferences = { ticketMoved: true, epicCompleted: true, needsAttention: true };

/** The VAPID key as the bytes the push service wants. */
function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function supported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Push notifications: enable this device, and choose which kinds, for all boards. */
export function NotificationsSection({
  initial = ALL_ON,
  vapidPublicKey = null,
}: {
  initial?: PushPreferences;
  vapidPublicKey?: string | null;
}) {
  const [prefs, setPrefs] = useState(initial);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported()) return;
    void navigator.serviceWorker
      .getRegistration("/sw.js")
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => setEnabled(!!subscription))
      .catch(() => {});
  }, []);

  async function change(key: keyof PushPreferences, next: boolean) {
    setError(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifications: { [key]: next } }),
    }).catch(() => null);
    if (!res?.ok) {
      setError("That did not save. Try again.");
      return;
    }
    setPrefs((p) => ({ ...p, [key]: next }));
  }

  // Permission is asked only here, on a tap.
  async function enable() {
    setBusy(true);
    setError(null);
    try {
      if (!vapidPublicKey) throw new Error("Notifications are not set up on this server.");
      if ((await Notification.requestPermission()) !== "granted") {
        throw new Error("Notifications are blocked. Allow them in your browser's settings.");
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(vapidPublicKey),
      });
      const res = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!res.ok) throw new Error("That did not save. Try again.");
      setEnabled(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-card border-line rounded-xl border p-4">
      <h2 className="text-ink mb-3 text-[11px] font-semibold tracking-[0.1em] uppercase">
        Notifications
      </h2>
      <p className="text-muted mb-2.5 text-[12px] leading-[1.5]">
        Choose what you hear about. These apply to all your boards.
      </p>
      <div className="mb-3 flex flex-col gap-1.5">
        {KINDS.map(({ key, label }) => (
          <label key={key} className="text-ink flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              role="switch"
              checked={prefs[key]}
              onChange={(e) => void change(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
      <button
        type="button"
        disabled={busy || enabled || !supported()}
        onClick={() => void enable()}
        className="border-line text-ink rounded-md border px-3 py-1.5 text-[12px] disabled:opacity-60"
      >
        {enabled ? "Enabled" : "Enable on this device"}
      </button>
      {error && (
        <p role="alert" className="text-crimson-text mt-1 text-[11px]">
          {error}
        </p>
      )}
    </section>
  );
}
