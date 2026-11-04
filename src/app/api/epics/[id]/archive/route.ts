import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { archiveEpic, restoreEpic } from "@/lib/board/service";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The active project when it owns the Epic, else null. */
async function owningProject(epicId: string) {
  const project = await activeProject();
  if (!project || (await repository().projectOfCard(epicId)) !== project.id) return null;
  return project;
}

/**
 * Moves an Epic and its tickets to the archive: off the board, not deleted.
 * Idempotent. Refused while an agent is working one of its tickets.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "epic-archive");
  if (refused) return refused;
  const { id } = await params;
  const project = await owningProject(id);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  const result = await archiveEpic(project.id, id);
  return result.ok
    ? Response.json({ archived: true })
    : Response.json({ error: result.reason, reason: "active-run" }, { status: result.status });
}

/**
 * Restores an archived Epic with the tickets its archive took; a ticket
 * archived on its own stays archived. Idempotent.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "epic-archive");
  if (refused) return refused;
  const { id } = await params;
  const project = await owningProject(id);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  const result = await restoreEpic(project.id, id);
  return result.ok
    ? Response.json({ archived: false })
    : Response.json({ error: result.reason }, { status: result.status });
}
