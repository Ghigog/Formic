import { activeProject, noProject } from "@/lib/board/project";
import { kpisFor } from "@/lib/kpi";

export const dynamic = "force-dynamic";

/** The project's KPI tiles and charts. `?window=30d` (default) or `all`. */
export async function GET(req: Request) {
  const project = await activeProject();
  if (!project) return noProject();
  const window = new URL(req.url).searchParams.get("window") === "all" ? "all" : "30d";
  return Response.json(await kpisFor(project.id, window));
}
