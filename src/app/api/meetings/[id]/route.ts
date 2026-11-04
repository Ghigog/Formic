import { asSignedIn, currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { updateSchema } from "../schema";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** The meeting, when it belongs to the active board. */
async function meetingOf(context: Context) {
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
  const project = await activeProject();
  if (!project) return { error: noProject() };
  const { id } = await context.params;
  const meeting = (await repository().meetings(project.id)).find((m) => m.id === id);
  if (!meeting) return { error: Response.json({ error: "Not found" }, { status: 404 }) };
  return { meeting };
}

/** Edits a meeting. */
export const PATCH = asSignedIn(async (req: Request, context: Context) => {
  const found = await meetingOf(context);
  if ("error" in found) return found.error;
  const body = updateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: body.error.issues[0]?.message ?? "Not a valid meeting." }, { status: 400 });
  }
  const repo = repository();
  await repo.updateMeeting(found.meeting.id, body.data);
  const meeting = (await repo.meetings(found.meeting.projectId)).find((m) => m.id === found.meeting.id);
  return Response.json({ meeting });
});

/** Deletes a meeting. */
export const DELETE = asSignedIn(async (_req: Request, context: Context) => {
  const found = await meetingOf(context);
  if ("error" in found) return found.error;
  await repository().deleteMeeting(found.meeting.id);
  return new Response(null, { status: 204 });
});
