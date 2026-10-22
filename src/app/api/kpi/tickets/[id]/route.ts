import { activeProject, noProject } from "@/lib/board/project";
import { ticketKpisFor } from "@/lib/kpi";

export const dynamic = "force-dynamic";

/** One ticket's column timeline with durations, pass rate and precision. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const project = await activeProject();
  if (!project) return noProject();
  const { id } = await params;
  const kpis = await ticketKpisFor(project.id, id);
  if (!kpis) return Response.json({ error: "No such ticket." }, { status: 404 });
  return Response.json(kpis);
}
