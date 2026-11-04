import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

/** The archive: every ticket and Epic archived off this project's board. */
export async function GET() {
  const repo = repository();
  const project = await activeProject();
  if (!project) return Response.json({ tickets: [], epics: [] });
  const [tickets, epics] = await Promise.all([repo.archivedTickets(project.id), repo.archivedEpics(project.id)]);
  return Response.json({ tickets, epics });
}
