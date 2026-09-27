import { activeProject, noProject } from "@/lib/board/project";
import { sentinelsFor } from "@/lib/sentinels/service";

export const dynamic = "force-dynamic";

/** Every sentinel's last report and any run in progress. */
export async function GET() {
  const project = await activeProject();
  if (!project) return noProject();
  return Response.json({ sentinels: await sentinelsFor(project.id) });
}
