import { NextRequest } from "next/server";
import { asSignedIn, currentUser } from "@/lib/auth/user";
import { canSeeBoard } from "@/lib/board/sharing";
import { z } from "zod";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { goldenBellsLeft, isMaxLevel, scoreOf } from "@/lib/colony/game";
import { ringBell } from "@/lib/colony/bell";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["ring", "arm", "disarm"]),
  projectId: z.string().min(1).optional(),
});

/**
 * The board the bell is for: the one the page names, which the cookie may
 * disagree with (a swap that backed out, another tab), else the cookie's.
 * A board the person cannot see answers 404.
 */
async function boardOf(projectId: string | null | undefined): Promise<{ id: string } | Response> {
  if (!projectId) return (await activeProject()) ?? noProject();
  const user = await currentUser();
  const found = user ? await repository().projectById(projectId) : null;
  if (!user || !found || !(await canSeeBoard(user, found))) {
    return Response.json({ error: "That project no longer exists." }, { status: 404 });
  }
  return found;
}

/** The golden bells the project has left, and whether one is armed. */
async function view(projectId: string) {
  const repo = repository();
  const [cards, bell] = await Promise.all([repo.boardCards(projectId), repo.goldenBell(projectId)]);
  const level = scoreOf(cards).level;
  const unlimited = isMaxLevel(level);
  // JSON cannot carry Infinity: at the top level the count is a flag instead.
  return { left: unlimited ? 0 : goldenBellsLeft(level, bell.used), armed: bell.armed, unlimited };
}

export async function GET(req?: NextRequest) {
  const project = await boardOf(req?.nextUrl?.searchParams.get("projectId") ?? (req ? new URL(req.url).searchParams.get("projectId") : null));
  if (project instanceof Response) return project;
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

  const project = await boardOf(parsed.data.projectId);
  if (project instanceof Response) return project;

  if (parsed.data.action === "ring") {
    return Response.json({ ...(await ringBell(project.id)), ...(await view(project.id)) });
  }
  if (parsed.data.action === "arm") {
    const { left, unlimited } = await view(project.id);
    if (left === 0 && !unlimited) return Response.json({ error: "No golden bell left.", left, armed: false }, { status: 400 });
  }
  await repository().setGoldenBellArmed(project.id, parsed.data.action === "arm");
  return Response.json(await view(project.id));
}
