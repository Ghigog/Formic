import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { ownsPreset } from "../../validate";

export const dynamic = "force-dynamic";

/**
 * Clears a preset marked out of usage: for one that was blamed for another
 * agent's limit before that was fixed, or whose plan already reset.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  if (!(await ownsPreset(user, id))) {
    return Response.json({ error: "That agent no longer exists." }, { status: 404 });
  }
  await repository().setPresetLimit(id, null);
  return new Response(null, { status: 204 });
}
