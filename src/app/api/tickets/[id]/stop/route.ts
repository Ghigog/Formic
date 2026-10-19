import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { limited, RUN } from "@/lib/rate-limit";
import { stopTicket } from "@/lib/runner/runner";

export const dynamic = "force-dynamic";

/** Stops the agent working a ticket, wherever it runs. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "ticket-stop");
  if (refused) return refused;
  const { id } = await params;
  const project = await activeProject();
  if (!project || (await repository().projectOfCard(id)) !== project.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const stopped = await stopTicket(project.id, id);
  if (!stopped) return Response.json({ error: "No agent is working this ticket." }, { status: 409 });
  return Response.json({ stopped });
}
