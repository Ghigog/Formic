import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { canSeeBoard } from "@/lib/board/sharing";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ projectId: z.string().min(1) });

/** Record that this person has taken the board's tour, so a new device does not offer it again. */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Expected a projectId." }, { status: 400 });

  const project = await repository().projectById(parsed.data.projectId);
  if (!project || !(await canSeeBoard(user, project))) {
    return Response.json({ error: "That project no longer exists." }, { status: 404 });
  }
  await repository().markBoardTourSeen(user.id, project.id);
  return Response.json({ ok: true });
}
