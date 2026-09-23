import { stopAll } from "@/lib/budget/controller";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

/** The global stop. Halts every run on the project and disposes its sandboxes. */
export async function POST() {
  const project = await activeProject();
  const stopped = await stopAll(project.id);
  return Response.json({ stopped });
}
