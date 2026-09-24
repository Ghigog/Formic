import { NextRequest } from "next/server";
import { z } from "zod";
import { repository } from "@/lib/db";
import { prdSchema } from "@/lib/domain/entities";
import { applyPrd } from "@/lib/agents/pipeline";
import { activeProject } from "@/lib/board/project";
import { canRetryEpic, deleteEpic, retryEpic } from "@/lib/board/service";

/** The active project, if this epic is on it. Anyone else's epic is a 404. */
async function projectOwning(epicId: string) {
  const project = await activeProject();
  if (!project) return null;
  return (await repository().projectOfCard(epicId)) === project.id ? project : null;
}

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export const dynamic = "force-dynamic";
// PATCH and POST can start a planning agent (see launch() in
// src/lib/agents/pipeline.ts). Matches the platform's function cap;
// DEFAULT_RUN_BUDGET stays under it.
export const maxDuration = 300;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = repository();

  const project = await projectOwning(id);
  const detail = project ? await repo.epicDetail(id) : null;
  if (!project || !detail) return notFound();

  const cards = await repo.boardCards(project.id);
  const epic = cards.find((c) => c.id === id);
  const children = cards.filter((c) => c.epicId === id);

  return Response.json({
    epic: epic ?? null,
    title: detail.title,
    rawRequest: detail.rawRequest,
    prd: detail.prd,
    children,
    canRetry: epic ? canRetryEpic(epic, detail) : false,
  });
}

const patchSchema = z.object({ prd: prdSchema });

/** Human edit of a generated PRD. The agent's output is a draft, not a verdict. */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await projectOwning(id);
  if (!project) return notFound();
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid PRD." },
      { status: 400 },
    );
  }

  await applyPrd(project.id, id, parsed.data.prd, true);

  return Response.json({ ok: true });
}

/** Starts a stalled Epic's planning again. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await projectOwning(id);
  if (!project) return notFound();
  const result = await retryEpic(project.id, id);
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: result.reason }, { status: result.status });
}

/** Deletes an Epic, its PRD and its tickets. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await projectOwning(id);
  if (!project) return notFound();
  const result = await deleteEpic(project.id, id);
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: result.reason }, { status: result.status });
}
