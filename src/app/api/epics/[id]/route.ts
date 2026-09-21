import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { prdSchema } from "@/lib/domain/entities";
import { publish } from "@/lib/events/bus";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = repository();

  const detail = await repo.epicDetail(id);
  if (!detail) return Response.json({ error: "Not found" }, { status: 404 });

  const project = await repo.defaultProject();
  const cards = await repo.boardCards(project.id);
  const epic = cards.find((c) => c.id === id);
  const children = cards.filter((c) => c.epicId === id);

  return Response.json({
    epic: epic ?? null,
    title: detail.title,
    rawRequest: detail.rawRequest,
    prd: detail.prd,
    children,
  });
}

const patchSchema = z.object({ prd: prdSchema });

/** Human edit of a generated PRD. The agent's output is a draft, not a verdict. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid PRD." },
      { status: 400 },
    );
  }

  const repo = repository();
  await repo.setEpicPrd(id, parsed.data.prd, true);

  const project = await repo.defaultProject();
  await publish(project.id, {
    type: "card.status",
    cardId: id,
    kind: "epic",
    status: "specified",
    stalledIn: null,
    stage: 2,
    blockedReason: null,
  });

  return Response.json({ ok: true });
}
