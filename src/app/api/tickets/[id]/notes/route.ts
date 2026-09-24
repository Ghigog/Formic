import { NextRequest } from "next/server";
import { z } from "zod";

import { repository } from "@/lib/db";
import { activeProject } from "@/lib/board/project";
import { MAX_NOTE, addNote } from "@/lib/coder/notes";

export const dynamic = "force-dynamic";

const body = z.object({ text: z.string().trim().min(1).max(MAX_NOTE) });

/** A person's note to the agent working a ticket, and to every later run of it. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await activeProject();
  if (!project || (await repository().projectOfCard(id)) !== project.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Write a note first." }, { status: 400 });
  await addNote(project.id, id, parsed.data.text);
  return Response.json({ ok: true });
}
