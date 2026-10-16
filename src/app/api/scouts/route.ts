import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { scoreOf } from "@/lib/colony/game";
import { maxScouts } from "@/lib/colony/reserve";
import { MIN_SCOUTS, scoutViews, sendScouts, swapScout } from "@/lib/coder/scouts";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    ticketId: z.string().min(1),
    count: z.number().int().min(MIN_SCOUTS).max(4),
    /** The agent template for each scout; null or absent runs the column's. */
    presets: z.array(z.string().min(1).nullable()).max(4).optional(),
  }),
  z.object({ action: z.literal("swap"), ticketId: z.string().min(1), scoutId: z.string().min(1) }),
]);

/** A ticket's scouts, and how many this board may send. */
export async function GET(req: NextRequest) {
  const project = await activeProject();
  if (!project) return noProject();
  const ticketId = req.nextUrl.searchParams.get("ticketId");
  if (!ticketId) return Response.json({ error: "Say which ticket." }, { status: 400 });
  const repo = repository();
  const ticket = await repo.ticketDetail(ticketId);
  if (!ticket || ticket.projectId !== project.id) return Response.json({ error: "Not found" }, { status: 404 });
  const level = scoreOf(await repo.boardCards(project.id)).level;
  return Response.json({ ...(await scoutViews(ticketId)), max: maxScouts(level), min: MIN_SCOUTS });
}

/** Sends scouts on a ticket in To Do, or swaps the one picked. */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say what to do with which ticket's scouts." }, { status: 400 });
  const project = await activeProject();
  if (!project) return noProject();

  const answer =
    parsed.data.action === "send"
      ? await sendScouts(project.id, parsed.data.ticketId, {
          count: parsed.data.count,
          ...(parsed.data.presets ? { presets: parsed.data.presets } : {}),
        })
      : await swapScout(project.id, parsed.data.ticketId, parsed.data.scoutId);
  if (!answer.ok) return Response.json({ error: answer.reason }, { status: 409 });
  return Response.json(await scoutViews(parsed.data.ticketId));
}
