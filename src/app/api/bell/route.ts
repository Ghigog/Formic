import { NextRequest } from "next/server";
import { asSignedIn } from "@/lib/auth/user";
import { z } from "zod";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { goldenBellsLeft, scoreOf } from "@/lib/colony/game";
import { ringBell } from "@/lib/colony/bell";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ action: z.enum(["ring", "arm", "disarm"]) });

/** The golden bells the project has left, and whether one is armed. */
async function view(projectId: string) {
  const repo = repository();
  const [cards, bell] = await Promise.all([repo.boardCards(projectId), repo.goldenBell(projectId)]);
  return { left: goldenBellsLeft(scoreOf(cards).level, bell.used), armed: bell.armed };
}

export async function GET() {
  const project = await activeProject();
  if (!project) return noProject();
  return Response.json(await view(project.id));
}

/**
 * Ring sends the silver bell: free, no golden bell is used up. Arm and disarm
 * toggle the golden bell; arming needs one left.
 */
export const POST = asSignedIn(postHandler);
async function postHandler(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say ring, arm or disarm." }, { status: 400 });

  const project = await activeProject();
  if (!project) return noProject();

  if (parsed.data.action === "ring") {
    return Response.json({ ...(await ringBell(project.id)), ...(await view(project.id)) });
  }
  if (parsed.data.action === "arm") {
    const { left } = await view(project.id);
    if (left === 0) return Response.json({ error: "No golden bell left.", left, armed: false }, { status: 400 });
  }
  await repository().setGoldenBellArmed(project.id, parsed.data.action === "arm");
  return Response.json(await view(project.id));
}
