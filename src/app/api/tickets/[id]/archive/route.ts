import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

/**
 * Moves a ticket to the archive: off the board, not deleted. Idempotent —
 * an already-archived ticket stays archived and the call still succeeds.
 */
export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = repository();
  const project = await activeProject();
  if (!project || (await repo.projectOfCard(id)) !== project.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await repo.ticketDetail(id))) {
    return Response.json({ error: "Not a ticket" }, { status: 404 });
  }
  await repo.updateTicket(id, { archived: true });
  return Response.json({ archived: true });
}
