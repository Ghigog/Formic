import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { spikeFindings } from "@/lib/board/spike-findings";

export const dynamic = "force-dynamic";

/** A spike's findings document, read from the board's branch. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await activeProject();
  if (!project || (await repository().projectOfCard(id)) !== project.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const ticket = await repository().ticketDetail(id);
  if (!ticket) return Response.json({ error: "Not found" }, { status: 404 });
  if (ticket.workType !== "spike") {
    return Response.json({ error: "Only a spike has findings." }, { status: 409 });
  }
  return Response.json(await spikeFindings(project, ticket));
}
