import { stopAll } from "@/lib/budget/controller";
import { activeProject, noProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

/** The global stop. Halts every run on the project and disposes its sandboxes. */
export async function POST() {
  const project = await activeProject();
  if (!project) return noProject();
  const stopped = await stopAll(project.id);
  return Response.json({ stopped });
}
