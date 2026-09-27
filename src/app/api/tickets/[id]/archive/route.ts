import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { archiveTicket } from "@/lib/board/service";

export const dynamic = "force-dynamic";

/** Drags a ticket onto the "New request" button: closes it for good. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await activeProject();
  if (!project || (await repository().projectOfCard(id)) !== project.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const result = await archiveTicket(project.id, id);
  if (!result.ok) return Response.json({ error: result.reason }, { status: 409 });
  return Response.json({ archived: true });
}
