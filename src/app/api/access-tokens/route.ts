import { z } from "zod";
import { asSignedIn, currentUser } from "@/lib/auth/user";
import { createToken, listTokens } from "@/lib/access-tokens";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  readOnly: z.boolean(),
});

/** The person's tokens that are still live: never a secret or a hash. */
export const GET = asSignedIn(async () => {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const tokens = await listTokens(user.id);
  return Response.json({ tokens: tokens.filter((t) => !t.revokedAt) });
});

/** Makes a token. The response carries its secret, once. */
export const POST = asSignedIn(async (req: Request) => {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Give the token a name." }, { status: 400 });
  const { name, readOnly, expiresInDays } = parsed.data;
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * DAY_MS) : null;
  const { id, secret } = await createToken(user.id, { name, readOnly, expiresAt });
  return Response.json({ id, secret }, { status: 201 });
});
