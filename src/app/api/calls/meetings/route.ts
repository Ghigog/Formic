import { asSignedIn, currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { repository } from "@/lib/db";
import { createSchema } from "./schema";

export const dynamic = "force-dynamic";

async function board() {
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
  const project = await activeProject();
  if (!project) return { error: noProject() };
  return { project };
}

/** The active board's meetings, soonest first. */
export async function GET() {
  const found = await board();
  if ("error" in found) return found.error;
  return Response.json({ meetings: await repository().meetings(found.project.id) });
}

/** Schedules a meeting. */
export const POST = asSignedIn(async (req: Request) => {
  const found = await board();
  if ("error" in found) return found.error;
  const body = createSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: body.error.issues[0]?.message ?? "Not a valid meeting." }, { status: 400 });
  }
  const meeting = await repository().createMeeting({ projectId: found.project.id, ...body.data });
  return Response.json({ meeting }, { status: 201 });
});
