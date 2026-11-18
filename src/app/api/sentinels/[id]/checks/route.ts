import { z } from "zod";
import { activeProject, noProject } from "@/lib/board/project";
import { asSignedIn, currentUser } from "@/lib/auth/user";
import { editRubricCheck, sentinelsFor } from "@/lib/sentinels/service";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ checkId: z.string().trim().min(1).max(10), note: z.string().trim().min(1).max(2000) });

/** Edits one check of the Sentinel's rubric, as the signed-in person asks and approves. */
export const POST = asSignedIn(postHandler);
async function postHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = limited(req, RUN, "sentinel-check");
  if (refused) return refused;

  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const project = await activeProject();
  if (!project) return noProject();
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say which check and what to change." }, { status: 400 });
  const { id } = await params;
  const started = await editRubricCheck(project.id, id, parsed.data.checkId, parsed.data.note, user.id);
  if (!started.ok) return Response.json({ error: started.error }, { status: started.status });
  return Response.json({ sentinels: await sentinelsFor(project.id) });
}
