import { NextRequest } from "next/server";
import { repository } from "@/lib/db";
import { activeProject, noProject } from "@/lib/board/project";
import { read, remove } from "@/lib/attachments/store";
import { attachmentUrlAllowed } from "@/lib/runner/runner";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export const dynamic = "force-dynamic";

/**
 * Whether this project may reach this attachment: still waiting under the
 * requestId the caller supplied (a request id is a client-generated secret,
 * unguessable by another project's session), or already claimed by one of
 * this project's own cards. One indexed query — the card it is attached to
 * and the project it was uploaded for are already on the row.
 */
async function reachable(
  projectId: string,
  attachmentId: string,
  requestId: string | null,
): Promise<boolean> {
  const scope = await repository().attachmentScope(attachmentId);
  if (!scope) return false;
  return scope.requestId ? scope.requestId === requestId : scope.projectId === projectId;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const expires = req.nextUrl.searchParams.get("expires");
  const token = req.nextUrl.searchParams.get("token");
  const signed = expires !== null && token !== null;
  if (signed) {
    if (!attachmentUrlAllowed(id, expires, token)) return notFound();
  } else {
    const project = await activeProject();
    if (!project) return noProject();

    const requestId = req.nextUrl.searchParams.get("requestId");
    if (!(await reachable(project.id, id, requestId))) return notFound();
  }

  const content = await read(id);
  if (!content) return notFound();

  // An HTML attachment must never render inline on Formic's own origin: a
  // browser navigating to its URL would execute it, opening a stored-XSS
  // hole. Every other type keeps the default so inline previews (e.g. <img
  // src>) still work.
  const headers: Record<string, string> = { "Content-Type": content.mimeType };
  if (content.mimeType === "text/html") {
    headers["Content-Disposition"] = "attachment";
  }

  return new Response(Buffer.from(content.bytes), { headers });
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
