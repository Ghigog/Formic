import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { currentUser, ownerScope } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

/** This person's saved presets, and which one each column runs on this board. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const repo = repository();
  const project = await activeProject();
  const [presets, columns] = await Promise.all([
    repo.listPresets(ownerScope(user)),
    project ? repo.columnAgents(project.id) : {},
  ]);
  return Response.json({ presets, columns });
}
