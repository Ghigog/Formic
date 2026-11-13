import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { limited, RUN } from "@/lib/rate-limit";
import { releaseWaiting } from "@/lib/coder/stack";
import { hasActiveRun } from "@/lib/domain/status";

export const dynamic = "force-dynamic";

/**
 * Moves a ticket to the archive: off the board, not deleted. Idempotent —
 * an already-archived ticket stays archived and the call still succeeds.
 * Tickets that depended on it stop waiting for it (their edges are removed)
 * and are released if everything else they wait for has merged.
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
  await repo.removeDependenciesOn(id);
  await releaseWaiting(project.id);
  return Response.json({ archived: true });
}

/**
 * Restores an archived ticket to its column: archived is the only thing that
 * changes, so status, stalledIn and misplacedIn still say where it came from.
 * Edges removed when it was archived are not added back: once archived, its
 * place in the graph is gone.
 * Idempotent — an unarchived ticket stays on the board.
 */
export async function DELETE(
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
  if (!(await repo.ticketDetail(id))) {
    return Response.json({ error: "Not a ticket" }, { status: 404 });
  }
  await repo.updateTicket(id, { archived: false });
  return Response.json({ archived: false });
}
