import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { limited, RUN } from "@/lib/rate-limit";
import { stopEpicAgent } from "@/lib/agents/card-actions";

export const dynamic = "force-dynamic";

/** Stops the agent working an Epic, wherever it runs. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "epic-stop");
  if (refused) return refused;
  const { id } = await params;
  const project = await activeProject();
  if (!project || (await repository().projectOfCard(id)) !== project.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await stopEpicAgent(project.id, id))) {
    return Response.json({ error: "No agent is working on this Epic." }, { status: 409 });
  }
  return Response.json({ stopped: true });
}
