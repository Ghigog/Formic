import { NextRequest } from "next/server";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { read, remove } from "@/lib/attachments/store";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export const dynamic = "force-dynamic";

/**
 * Whether this project may reach this attachment: still waiting under the
 * requestId the caller supplied (a request id is a client-generated secret,
 * unguessable by another project's session), or already claimed by one of
 * this project's own cards.
 */
async function reachable(
  projectId: string,
  attachmentId: string,
  requestId: string | null,
): Promise<boolean> {
  const repo = repository();

  if (requestId) {
    const pending = await repo.attachmentsFor({ requestId });
    if (pending.some((a) => a.id === attachmentId)) return true;
  }

  const cards = await repo.boardCards(projectId);
  const claimed = await Promise.all(
    cards.map((card) =>
      repo.attachmentsFor(card.kind === "epic" ? { epicId: card.id } : { ticketId: card.id }),
    ),
  );
  return claimed.some((list) => list.some((a) => a.id === attachmentId));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await activeProject();
  if (!project) return noProject();

  const requestId = req.nextUrl.searchParams.get("requestId");
  if (!(await reachable(project.id, id, requestId))) return notFound();

  const content = await read(id);
  if (!content) return notFound();

  return new Response(Buffer.from(content.bytes), {
    headers: { "Content-Type": content.mimeType },
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = await activeProject();
  if (!project) return noProject();

  const requestId = req.nextUrl.searchParams.get("requestId");
  if (!(await reachable(project.id, id, requestId))) return notFound();

  await remove(id);
  return Response.json({ ok: true });
}
