import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { pushConfigured, sendPush } from "@/lib/push/send";

export const dynamic = "force-dynamic";

/** Sends a test notification to every device the signed-in person has enabled. */
export async function POST() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  if (!pushConfigured()) {
    return Response.json({ error: "Notifications are not set up on this server. Its VAPID keys are missing." }, { status: 503 });
  }
  if ((await repository().pushSubscriptions(user.id)).length === 0) {
    return Response.json({ error: "No device is enabled. Tap Enable on this device first." }, { status: 404 });
  }

  const result = await sendPush(user.id, { title: "Formic", body: "Notifications work on this device." });
  if (result.sent === 0) {
    return Response.json({ error: "The push service turned it down. Check the server log." }, { status: 502 });
  }
  return Response.json({ ok: true, ...result });
}
