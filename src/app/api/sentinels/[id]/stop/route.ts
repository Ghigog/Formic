import { activeProject, noProject } from "@/lib/board/project";
import { asSignedIn } from "@/lib/auth/user";
import { sentinelsFor, stopSentinel } from "@/lib/sentinels/service";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Stops the sentinel's running audit or calibration. */
export const POST = asSignedIn(postHandler);
async function postHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = limited(req, RUN, "sentinel-stop");
  if (refused) return refused;

  const project = await activeProject();
  if (!project) return noProject();
  const { id } = await params;
  if (!(await stopSentinel(project.id, id))) return Response.json({ error: "Nothing is running." }, { status: 409 });
  return Response.json({ sentinels: await sentinelsFor(project.id) });
}
