import { stopAll } from "@/lib/budget/controller";
import { activeProject, noProject } from "@/lib/board/project";
import { credentialsForProject } from "@/lib/auth/credentials";

export const dynamic = "force-dynamic";

/** The global stop. Halts every run on the project and disposes its sandboxes. */
export async function POST() {
  const project = await activeProject();
  if (!project) return noProject();
  // The key its sandboxes were spawned with, when the owner brought their
  // own: killing one by id needs the same account that created it.
  const { e2bKey } = await credentialsForProject(project);
  const stopped = await stopAll(project.id, undefined, e2bKey);
  return Response.json({ stopped });
}
