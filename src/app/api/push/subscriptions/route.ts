import { z } from "zod";
import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

const saveSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
const deleteSchema = z.object({ endpoint: z.string().url() });

/** Saves this device's push subscription for the signed-in person. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const body = saveSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Send the device's push subscription." }, { status: 400 });

  const { endpoint, keys } = body.data;
  await repository().savePushSubscription(user.id, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
  return Response.json({ ok: true });
}

/** Forgets this device's push subscription. */
export async function DELETE(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const body = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Send the endpoint to forget." }, { status: 400 });

  await repository().deletePushSubscription(body.data.endpoint, user.id);
  return Response.json({ ok: true });
}
