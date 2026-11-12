import { asSignedIn, currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The person has read the PM's chat on the active board, up to now. */
export const POST = asSignedIn(postHandler);
async function postHandler() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const project = await activeProject();
  if (!project) return noProject();
  const readAt = new Date();
  await repository().markPmRead(user.id, project.id, readAt);
  return Response.json({ readAt: readAt.toISOString() });
}
