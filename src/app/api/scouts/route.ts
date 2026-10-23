import { NextRequest } from "next/server";
import { asSignedIn } from "@/lib/auth/user";
import { z } from "zod";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { scoutViews, sendScouts, removeScout, swapScout } from "@/lib/coder/scouts";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    ticketId: z.string().min(1),
  }),
  z.object({ action: z.literal("swap"), ticketId: z.string().min(1), scoutId: z.string().min(1) }),
  z.object({ action: z.literal("remove"), ticketId: z.string().min(1), scoutId: z.string().min(1) }),
]);

/** A ticket's scouts. */
export async function GET(req: NextRequest) {
  const project = await activeProject();
  if (!project) return noProject();
  const ticketId = req.nextUrl.searchParams.get("ticketId");
  if (!ticketId) return Response.json({ error: "Say which ticket." }, { status: 400 });
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket || ticket.projectId !== project.id) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(await scoutViews(ticketId));
}

/** Sends a scout on a ticket in In Progress, swaps the one picked, or takes one off. */
export const POST = asSignedIn(postHandler);
async function postHandler(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say what to do with which ticket's scouts." }, { status: 400 });
  const project = await activeProject();
  if (!project) return noProject();

  const body = parsed.data;
  const answer =
    body.action === "send"
      ? await sendScouts(project.id, body.ticketId)
      : body.action === "swap"
        ? await swapScout(project.id, body.ticketId, body.scoutId)
        : await removeScout(project.id, body.ticketId, body.scoutId);
  if (!answer.ok) return Response.json({ error: answer.reason }, { status: 409 });
  return Response.json(await scoutViews(parsed.data.ticketId));
}
