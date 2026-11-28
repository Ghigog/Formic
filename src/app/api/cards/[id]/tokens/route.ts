import { activeProject, noProject } from "@/lib/board/project";
import { cardTokensFor } from "@/lib/kpi/card-tokens";

export const dynamic = "force-dynamic";

/** The tokens one card used in each column it passed through, and in total. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const project = await activeProject();
  if (!project) return noProject();
  const { id } = await params;
  const kind = new URL(req.url).searchParams.get("kind") === "epic" ? "epic" : "ticket";
  const tokens = await cardTokensFor(project.id, kind, id);
  if (!tokens) return Response.json({ error: "No such card." }, { status: 404 });
  return Response.json(tokens);
}
