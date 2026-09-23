import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { collectCliRuns } from "@/lib/runner/runner";
import { launch } from "@/lib/agents/pipeline";

export const dynamic = "force-dynamic";

export async function GET() {
  const repo = repository();
  const project = await activeProject();
  if (!project) return Response.json({ project: null, cards: [] });
  // A refresh also takes any agent run that finished without its webhook.
  // Detached: the cards it moves arrive as events, not in this response.
  launch(() => collectCliRuns(project.id), "collecting agent runs");
  const cards = await repo.boardCards(project.id);
  return Response.json({ project, cards });
}
