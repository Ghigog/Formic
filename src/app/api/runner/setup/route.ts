import { activeProject, noProject } from "@/lib/board/project";
import { boardHasAgent } from "@/lib/board/first-agent";
import { runnerSetup } from "@/lib/runner/setup";

export const dynamic = "force-dynamic";

/**
 * Whether the active project's repository can run agents yet. GET asks,
 * and the board's setup dialog polls it until the pull request is merged;
 * POST is the person's yes, which opens the setup pull request.
 */
export async function GET() {
  return setup(false);
}

/** The person said yes: open the setup pull request. */
export async function POST() {
  return setup(true);
}

async function setup(approve: boolean) {
  const project = await activeProject();
  if (!project) return noProject();
  // A board with no agent, on a column or the PM, has nothing to set up; the
  // first one picked starts it.
  if (!(await boardHasAgent(project.id))) {
    return Response.json({ state: "ready" });
  }
  try {
    return Response.json(await runnerSetup(project, { approve }));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return Response.json({ state: "blocked", reason }, { status: 502 });
  }
}
