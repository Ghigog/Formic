import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { queensEarned, scoreOf } from "@/lib/colony/game";
import { publish } from "@/lib/events/bus";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ cardId: z.string().min(1) });

/** How many Queens the colony has earned and not yet placed or spent. */
export async function GET() {
  const project = await activeProject();
  if (!project) return noProject();
  const repo = repository();
  const [cards, placed, spent] = await Promise.all([
    repo.boardCards(project.id),
    repo.listQueens(project.id),
    repo.queensSpent(project.id),
  ]);
  return Response.json({ unspent: Math.max(0, queensEarned(scoreOf(cards).level) - placed.length - spent) });
}

/**
 * Places a Queen on a ticket or an Epic. Queens are earned with levels; one
 * taken off again stays spent, so clearing never gives it back.
 */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say which card." }, { status: 400 });

  const project = await activeProject();
  if (!project) return noProject();
  const repo = repository();

  const cards = await repo.boardCards(project.id);
  const card = cards.find((c) => c.id === parsed.data.cardId);
  if (!card) return Response.json({ error: "Not found" }, { status: 404 });
  if (card.kind === "epic" && card.childCount === 0) {
    return Response.json({ error: "A draft with no tickets cannot take a Queen." }, { status: 422 });
  }
  if (card.queen) return Response.json({ error: "It already has a Queen." }, { status: 409 });

  const [placed, spent] = await Promise.all([repo.listQueens(project.id), repo.queensSpent(project.id)]);
  const unspent = queensEarned(scoreOf(cards).level) - placed.length - spent;
  if (unspent <= 0) return Response.json({ error: "No unspent Queens." }, { status: 409 });

  const queen = await repo.placeQueen(project.id, card.id, card.kind);
  if (!queen) return Response.json({ error: "It already has a Queen." }, { status: 409 });

  await publish(project.id, { type: "card.queen", cardId: card.id, kind: card.kind });
  return Response.json({ queen, unspent: unspent - 1 }, { status: 201 });
}
