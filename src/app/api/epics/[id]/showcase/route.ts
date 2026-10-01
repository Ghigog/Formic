import { NextRequest } from "next/server";
import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { generateShowcase } from "@/lib/board/service";
import { limited, RUN } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
// generateShowcase can run the PM Agent (see launch() in
// src/lib/agents/pipeline.ts). Matches the platform's function cap.
export const maxDuration = 300;

/** The active project, if this epic is on it. Anyone else's epic is a 404. */
async function projectOwning(epicId: string) {
  const project = await activeProject();
  if (!project) return null;
  return (await repository().projectOfCard(epicId)) === project.id ? project : null;
}

/** Starts the PM Agent on a done Epic's showcase. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = limited(req, RUN, "run-start");
  if (refused) return refused;

  const { id } = await params;
  const project = await projectOwning(id);
  if (!project) return Response.json({ error: "Not found" }, { status: 404 });
  const result = await generateShowcase(project.id, id);
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: result.reason }, { status: result.status });
}
