import "server-only";

import { redact } from "@/lib/secrets/redact";
import { env } from "@/lib/secrets/env";

/**
 * The one place that turns "something is wrong" into a message a human sees.
 * Used for error spikes (see error-tracking.ts) and, from the smoke-test
 * workflow, for a failed deploy or a health check reporting `ok: false`.
 *
 * Without ALERT_WEBHOOK_URL configured, an alert still reaches the server
 * log — degrading like every other optional credential here — rather than
 * throwing or silently vanishing.
 */
export async function sendAlert(message: string): Promise<void> {
  const text = redact(message);
  const url = env().ALERT_WEBHOOK_URL;
  if (!url) {
    console.warn(`[formic] alert (no ALERT_WEBHOOK_URL configured): ${text}`);
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Slack- and Discord-compatible incoming webhooks both accept `text`.
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[formic] alert webhook responded ${res.status}: ${text}`);
    }
  } catch (e) {
    console.error("[formic] failed to send alert:", redact(String(e)), "-- alert was:", text);
  }
}
