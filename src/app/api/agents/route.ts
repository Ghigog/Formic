import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { currentUser, ownerScope } from "@/lib/auth/user";

export const dynamic = "force-dynamic";

/** This person's saved presets, which one each column runs with any override on it, and what each has used. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const repo = repository();
  const project = await activeProject();
  const [presets, columns, overrides, usage] = await Promise.all([
    repo.listPresets(ownerScope(user)),
    project ? repo.columnAgents(project.id) : {},
    project ? repo.columnOverrides(project.id) : {},
    repo.agentTokensByPreset(),
  ]);
  return Response.json({ presets, columns, overrides, usage });
}
