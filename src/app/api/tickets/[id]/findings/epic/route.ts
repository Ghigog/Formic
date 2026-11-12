import { NextRequest } from "next/server";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { createEpicFromSpike, SpikeFindingsMissing } from "@/lib/board/service";
import { asSignedIn } from "@/lib/auth/user";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// Starts the Product Agent (see launch() in src/lib/agents/pipeline.ts).
export const maxDuration = 300;

/** Makes an Epic from the spike's findings; the Product Agent writes its PRD. */
export const POST = asSignedIn(postHandler);
async function postHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;

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
  try {
    const { card, existing } = await createEpicFromSpike(project.id, id);
    return Response.json({ card, existing }, { status: existing ? 200 : 201 });
  } catch (err) {
    if (err instanceof SpikeFindingsMissing) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
