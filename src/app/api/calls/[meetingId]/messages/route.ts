import { z } from "zod";

import { asSignedIn, currentUser } from "@/lib/auth/user";
import { activeProject, noProject } from "@/lib/board/project";
import { ask } from "@/lib/calls/turn";
import { MAX_NOTE } from "@/lib/coder/notes";
import { repository } from "@/lib/db";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// POST starts the guest's answer (see launch() in src/lib/agents/pipeline.ts).
export const maxDuration = 300;

type Context = { params: Promise<{ meetingId: string }> };

const askSchema = z.object({ text: z.string().trim().min(1).max(MAX_NOTE) });

/** The meeting, when it belongs to the active board. */
async function meetingOf(context: Context) {
  const user = await currentUser();
  if (!user) return { error: Response.json({ error: "Sign in first." }, { status: 401 }) };
  const project = await activeProject();
  if (!project) return { error: noProject() };
  const { meetingId } = await context.params;
  const meeting = (await repository().meetings(project.id)).find((m) => m.id === meetingId);
  if (!meeting) return { error: Response.json({ error: "Not found" }, { status: 404 }) };
  return { meeting };
}

async function state(projectId: string, meetingId: string) {
  const [meetings, messages] = await Promise.all([
    repository().meetings(projectId),
    repository().callMessages(projectId, meetingId),
  ]);
  return { meeting: meetings.find((m) => m.id === meetingId) ?? null, messages };
}

/** The call: its meeting (agenda, guests) and every message so far. Polled for pending answers. */
export async function GET(_req: Request, context: Context) {
  const found = await meetingOf(context);
  if ("error" in found) return found.error;
  return Response.json(await state(found.meeting.projectId, found.meeting.id));
}

/** Says something in the call. The guest's answer arrives on a later GET. */
export const POST = asSignedIn(async (req: Request, context: Context) => {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;
  const found = await meetingOf(context);
  if ("error" in found) return found.error;
  const body = askSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Say something first." }, { status: 400 });
  await ask(found.meeting.projectId, found.meeting.id, body.data.text);
  return Response.json(await state(found.meeting.projectId, found.meeting.id));
});
