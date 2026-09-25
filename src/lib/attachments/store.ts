import "server-only";

import { repository } from "@/lib/db";
import type { AttachmentContent } from "@/lib/db/repository";
import type { AttachmentKind, AttachmentSummary } from "@/lib/domain/entities";

function kindOf(mimeType: string): AttachmentKind {
  return mimeType.startsWith("image/") ? "image" : "file";
}

/** Turns a browser File into what repository().createAttachment expects. */
export async function upload(input: {
  projectId: string;
  requestId: string;
  file: File;
}): Promise<AttachmentSummary> {
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const attachment = await repository().createAttachment({
    projectId: input.projectId,
    requestId: input.requestId,
    filename: input.file.name,
    mimeType: input.file.type,
    kind: kindOf(input.file.type),
    size: bytes.length,
    bytes,
  });
  // Until a card claims it, GET/DELETE only accept this attachment for the
  // requestId it was uploaded under (see reachable() in [id]/route.ts) — so
  // the url handed back must carry that proof, or the browser's own preview
  // 404s on the very attachment it just uploaded.
  return { ...attachment, url: `${attachment.url}?requestId=${encodeURIComponent(input.requestId)}` };
}

export async function remove(id: string): Promise<void> {
  await repository().deleteAttachments([id]);
}

export async function read(id: string): Promise<AttachmentContent | null> {
  return repository().attachmentContent(id);
}
