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

/**
 * Pushes to every device this person has subscribed. A subscription the push
 * service answers 404 or 410 to has expired, so it is dropped. Any other
 * failure is left alone: the next push tries again.
 */
export async function sendPush(userId: string, payload: PushPayload): Promise<void> {
  if (!pushConfigured()) return;
  const repo = repository();
  const subscriptions = await repo.pushSubscriptions(userId);
  if (subscriptions.length === 0) return;

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
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await repo.deletePushSubscription(s.endpoint, userId);
      }
    }),
  );
}
