import { repository } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const repo = repository();
  const project = await repo.defaultProject();
  const cards = await repo.boardCards(project.id);
  return Response.json({ project, cards });
}
