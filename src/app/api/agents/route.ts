import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

/** Saved presets, and which one each column runs on this board. */
export async function GET() {
  const repo = repository();
  const project = await activeProject();
  const [presets, columns] = await Promise.all([
    repo.listPresets(),
    repo.columnAgents(project.id),
  ]);
  return Response.json({ presets, columns });
}
