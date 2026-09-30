import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { collectCliRuns } from "@/lib/runner/runner";
import { launch } from "@/lib/agents/pipeline";
import { sweepOpenPullRequests } from "@/lib/review/pipeline";
import { sweepIdleCards } from "@/lib/board/idle";
import { limited, REFRESH } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // A refresh launches the sweeps, and the UI polls — so the board gets its
  // own generous budget rather than the shared run-start one.
  const refused = limited(req, REFRESH, "board-refresh");
  if (refused) return refused;

  const repo = repository();
  const project = await activeProject();
  if (!project) return Response.json({ project: null, cards: [] });
  // A refresh also takes any agent run that finished without its webhook.
  // Detached: the cards it moves arrive as events, not in this response.
  launch(() => collectCliRuns(project.id), "collecting agent runs");
  launch(() => sweepOpenPullRequests(project.id), "checking open pull requests");
  launch(() => sweepIdleCards(project.id), "restarting idle cards");
  const cards = await repo.boardCards(project.id);
  return Response.json({ project, cards });
}
