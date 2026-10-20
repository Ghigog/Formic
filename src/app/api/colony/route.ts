import { NextRequest } from "next/server";
import { asSignedIn } from "@/lib/auth/user";
import { z } from "zod";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { scoreOf } from "@/lib/colony/game";
import {
  AUTO_SCOUT_LEVEL,
  MAX_COLONY,
  effectiveColony,
  maxScouts,
  nextFloorLevel,
  nextScoutLevel,
  reserveFloor,
  slotsInUse,
} from "@/lib/colony/reserve";
import { startQueued } from "@/lib/board/queue";
import type { ProjectSummary } from "@/lib/db/repository";
import type { BoardCard } from "@/lib/domain/entities";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  colonySize: z.number().int().min(1).max(MAX_COLONY).nullable(),
  colonyReserve: z.number().int().min(0).max(MAX_COLONY),
  autoScout: z.boolean(),
});

/** The colony as the Nest shows it: what is set, what the level allows, what is in use. */
function view(project: ProjectSummary, cards: BoardCard[]) {
  const level = scoreOf(cards).level;
  return {
    ...effectiveColony(project, level),
    level,
    floor: reserveFloor(level),
    nextFloorLevel: nextFloorLevel(level),
    maxScouts: maxScouts(level),
    nextScoutLevel: nextScoutLevel(level),
    autoScoutLevel: AUTO_SCOUT_LEVEL,
    maxColony: MAX_COLONY,
    inUse: slotsInUse(cards),
  };
}

export async function GET() {
  const project = await activeProject();
  if (!project) return noProject();
  return Response.json(view(project, await repository().boardCards(project.id)));
}

/**
 * Sets the colony's size, reserve and auto-scouting. A reserve below the
 * level's floor, or auto-scouting before its level, is held to what the
 * level allows rather than refused: the answer says what was kept.
 */
export const POST = asSignedIn(postHandler);
async function postHandler(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say the colony's size, reserve and auto-scouting." }, { status: 400 });

  const project = await activeProject();
  if (!project) return noProject();
  const repo = repository();
  const cards = await repo.boardCards(project.id);
  const kept = effectiveColony(parsed.data, scoreOf(cards).level);
  await repo.setColony(project.id, kept);
  // A bigger colony, or a smaller reserve, may have room for what is waiting.
  await startQueued(project.id);
  return Response.json(view({ ...project, ...kept }, cards));
}
