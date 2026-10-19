import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { limited, RUN } from "@/lib/rate-limit";
import { hasActiveRun } from "@/lib/domain/status";

export const dynamic = "force-dynamic";

/**
 * Moves a ticket to the archive: off the board, not deleted. Idempotent —
 * an already-archived ticket stays archived and the call still succeeds.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "ticket-archive");
  if (refused) return refused;
  const { id } = await params;
  const repo = repository();
  const project = await activeProject();
  if (!project || (await repo.projectOfCard(id)) !== project.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const ticket = await repo.ticketDetail(id);
  if (!ticket) {
    return Response.json({ error: "Not a ticket" }, { status: 404 });
  }
  if (hasActiveRun(ticket, await repo.cardById(id))) {
    return Response.json(
      { error: "An agent is working this ticket. Stop it before archiving.", reason: "active-run" },
      { status: 409 },
    );
  }
  await repo.updateTicket(id, { archived: true });
  return Response.json({ archived: true });
}
