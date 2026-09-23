import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

export async function GET() {
  const repo = repository();
  const project = await activeProject();
  if (!project) return Response.json({ project: null, cards: [] });
  const cards = await repo.boardCards(project.id);
  return Response.json({ project, cards });
}
