import { asSignedIn, currentUser } from "@/lib/auth/user";
import { revokeToken } from "@/lib/access-tokens";

export const dynamic = "force-dynamic";

/** Revokes one of the person's own tokens. */
export const DELETE = asSignedIn(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const { id } = await params;
  if (!(await revokeToken(user.id, id))) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(null, { status: 204 });
});
