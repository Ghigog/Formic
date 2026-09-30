import { activeProject, noProject } from "@/lib/board/project";
import { sentinelsFor, summonSentinel } from "@/lib/sentinels/service";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// The audit runs after the response (see launch()), inside this cap.
export const maxDuration = 300;

/** Summons one sentinel: it audits the project's code and reports. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;

  const project = await activeProject();
  if (!project) return noProject();
  const { id } = await params;
  const result = await summonSentinel(project.id, id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ sentinels: await sentinelsFor(project.id) }, { status: 202 });
}
