import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { PROJECT_COOKIE } from "@/lib/board/project";
import { currentUser } from "@/lib/auth/user";
import { boardFor, canSeeBoard } from "@/lib/board/sharing";
import { boardPropsFor } from "@/lib/board/board-props";
import { EXAMPLE_PROJECT_NAME } from "@/lib/board/example";
import { cookieHeader } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ projectId: z.string().min(1) });

/**
 * Load another board in place: its data for the page to show, and this
 * browser switched to it. It does not record the board as opened (see
 * ../opened/route.ts), so a run of swaps leaves the order of boards alone.
 */
export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Expected a projectId." }, { status: 400 });

  const found = await repository().projectById(parsed.data.projectId);
  const isExample = !!found && !found.repoFullName && found.name === EXAMPLE_PROJECT_NAME;
  if (!found || isExample || !(await canSeeBoard(user, found))) {
    return Response.json({ error: "That project no longer exists." }, { status: 404 });
  }
  const project = await boardFor(user, found);

  const res = Response.json({ project, board: await boardPropsFor(project, user) });
  res.headers.append("Set-Cookie", cookieHeader(PROJECT_COOKIE, encodeURIComponent(project.id), 31536000));
  return res;
}
