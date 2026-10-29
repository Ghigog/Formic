import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { currentUser } from "@/lib/auth/user";
import { canSeeBoard } from "@/lib/board/sharing";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ projectId: z.string().min(1) });

/** Record a board as opened: what ends a run of swaps (see ../swap/route.ts). */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Expected a projectId." }, { status: 400 });

  const project = await repository().projectById(parsed.data.projectId);
  if (!project || !(await canSeeBoard(user, project))) {
    return Response.json({ error: "That project no longer exists." }, { status: 404 });
  }
  await repository().markOpened(user.id, project.id);
  return Response.json({ ok: true });
}
