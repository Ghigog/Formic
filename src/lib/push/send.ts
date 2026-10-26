import "server-only";

import webpush from "web-push";
import { repository } from "@/lib/db";

export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping the notification goes; the board when omitted. */
  url?: string;
}

/** Whether the VAPID keys are set; without them nothing can be pushed. */
export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

let warnedUnconfigured = false;

/** How a push went: devices it reached, and devices it did not. */
export interface PushResult {
  sent: number;
  failed: number;
}

/**
 * Pushes to every device this person has subscribed. A subscription the push
 * service answers 404 or 410 to has expired, so it is dropped. Any other
 * failure is logged and left alone: the next push tries again.
 */
export async function sendPush(userId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0 };
  if (!pushConfigured()) {
    if (warnedUnconfigured) return result;
    warnedUnconfigured = true;
    console.warn("[formic] push skipped: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must all be set");
    return result;
  }
  const repo = repository();
  const subscriptions = await repo.pushSubscriptions(userId);
  if (subscriptions.length === 0) return result;

  const options = {
    vapidDetails: {
      subject: process.env.VAPID_SUBJECT!,
      publicKey: process.env.VAPID_PUBLIC_KEY!,
      privateKey: process.env.VAPID_PRIVATE_KEY!,
    },
  };
  const body = JSON.stringify(payload);
  await Promise.all(
    subscriptions.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, options);
        result.sent++;
      } catch (e) {
        result.failed++;
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await repo.deletePushSubscription(s.endpoint, userId);
        else console.error(`[formic] push to ${new URL(s.endpoint).host} failed:`, status ?? "", e);
      }
    }),
  );
  return result;
}
