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
  return repository().createAttachment({
    projectId: input.projectId,
    requestId: input.requestId,
    filename: input.file.name,
    mimeType: input.file.type,
    kind: kindOf(input.file.type),
    size: bytes.length,
    bytes,
  });
}

export async function remove(id: string): Promise<void> {
  await repository().deleteAttachments([id]);
}

export async function read(id: string): Promise<AttachmentContent | null> {
  return repository().attachmentContent(id);
}
