import { repository } from "@/lib/db";
import { stopAll } from "@/lib/budget/controller";

export const dynamic = "force-dynamic";

/** The global stop. Halts every run on the project and disposes its sandboxes. */
export async function POST() {
  const project = await repository().defaultProject();
  const stopped = await stopAll(project.id);
  return Response.json({ stopped });
}
