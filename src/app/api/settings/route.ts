import { z } from "zod";
import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { hintFor, seal } from "@/lib/secrets/vault";

export const dynamic = "force-dynamic";

/** A new key; null removes the saved one; omitted leaves it. */
const keySchema = z.string().trim().min(1).max(500).nullable().optional();
const bodySchema = z.object({ e2bKey: keySchema });

function sealed(value: string | null | undefined, cipher: string, hint: string) {
  if (value === undefined) return {};
  if (value === null) return { [cipher]: null, [hint]: null };
  return { [cipher]: seal(value), [hint]: hintFor(value) };
}

/** Saves this person's sandbox key. Never returns it. */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: body.error.issues[0]?.message ?? "Malformed." }, { status: 400 });
  }

  const updated = await repository().updateUser(user.id, {
    ...sealed(body.data.e2bKey, "e2bKeyCipher", "e2bKeyHint"),
  });
  return Response.json({ e2bKeyHint: updated.e2bKeyHint });
}
