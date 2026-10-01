import { activeProject, noProject } from "@/lib/board/project";
import { createBacklogItem } from "@/lib/board/service";
import { requestFromReport } from "@/lib/sentinels/epic";
import { SENTINELS } from "@/lib/sentinels/roster";
import { sentinelsFor } from "@/lib/sentinels/service";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// Starts the Product Agent, as POST /api/epics does.
export const maxDuration = 300;

/** Turns a sentinel's latest report into a Backlog Epic. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;

  const project = await activeProject();
  if (!project) return noProject();
  const { id } = await params;
  const sentinel = SENTINELS.find((s) => s.id === id);
  const state = (await sentinelsFor(project.id))[id];
  if (!sentinel || !state || state.stars === null || !state.report) {
    return Response.json({ error: "This sentinel has not reported yet." }, { status: 404 });
  }
  if (state.stars === 5) {
    return Response.json({ error: "A 5-star report leaves nothing to fix." }, { status: 409 });
  }
  const card = await createBacklogItem(
    project.id,
    requestFromReport(sentinel, { stars: state.stars, summary: state.summary, report: state.report }),
  );
  return Response.json({ card }, { status: 201 });
}
