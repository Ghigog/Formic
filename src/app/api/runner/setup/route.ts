import { activeProject, noProject } from "@/lib/board/project";
import { boardHasAgent } from "@/lib/board/first-agent";
import { runnerSetup } from "@/lib/runner/setup";

export const dynamic = "force-dynamic";

/**
 * Whether the active project's repository can run CLI agents yet, opening
 * the setup pull request the first time it cannot. The board's setup dialog
 * polls this until the pull request is merged.
 */
export async function GET() {
  const project = await activeProject();
  if (!project) return noProject();
  // A board with no agent, on a column or the PM, has nothing to set up; the
  // first one picked starts it.
  if (!(await boardHasAgent(project.id))) {
    return Response.json({ state: "ready" });
  }
  try {
    return Response.json(await runnerSetup(project));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return Response.json({ state: "blocked", reason }, { status: 502 });
  }
}
