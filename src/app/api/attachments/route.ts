import { NextRequest } from "next/server";
import { checkBatch } from "@/lib/attachments/limits";
import { upload } from "@/lib/attachments/store";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const project = await activeProject();
  if (!project) return noProject();

  const form = await req.formData().catch(() => null);
  if (!form) {
    return Response.json({ error: "Expected a multipart form." }, { status: 400 });
  }

  const requestId = form.get("requestId");
  const projectId = form.get("projectId");
  const file = form.get("file");

  if (typeof requestId !== "string" || !requestId) {
    return Response.json({ error: "Missing requestId." }, { status: 400 });
  }
  if (projectId !== project.id) {
    return Response.json({ error: "Wrong project." }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return Response.json({ error: "Missing file." }, { status: 400 });
  }

  const existing = await repository().attachmentsFor({ requestId });
  const result = checkBatch(existing.length, [
    { name: file.name, type: file.type, size: file.size },
  ]);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  const attachment = await upload({ projectId: project.id, requestId, file });
  return Response.json({ attachment }, { status: 201 });
}

/** Every attachment a card carries: what the Epic or Ticket drawer's gallery shows. */
export async function GET(req: NextRequest) {
  const project = await activeProject();
  if (!project) return noProject();

  const epicId = req.nextUrl.searchParams.get("epicId");
  const ticketId = req.nextUrl.searchParams.get("ticketId");
  if (!epicId && !ticketId) {
    return Response.json({ error: "Expected an epicId or ticketId." }, { status: 400 });
  }

  const repo = repository();
  // The card has to be this project's, which is one indexed lookup. Reading
  // the board to check it moved every Epic's PRD and every ticket's text out
  // of the database each time a drawer's gallery loaded.
  const cardId = epicId ?? ticketId!;
  const owner = await repo.projectOfCard(cardId);
  if (owner !== project.id) return Response.json({ attachments: [] });

  const attachments = await repo.attachmentsFor(epicId ? { epicId } : { ticketId: ticketId! });
  return Response.json({ attachments });
}
