/**
 * Isomorphic limits: imported by the request dialog (to reject a bad file
 * before it uploads) and by the API route (to enforce the same rule
 * server-side, for anyone who bypasses the client check). No "server-only"
 * here on purpose.
 */

export const MAX_ATTACHMENTS_PER_REQUEST = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;

export type AllowedAttachmentType = (typeof ALLOWED_ATTACHMENT_TYPES)[number];

/** Just enough of a File/Blob to check, without depending on the DOM type. */
export interface AttachmentFileLike {
  name: string;
  type: string;
  size: number;
}

export type AttachmentCheckResult =
  | { ok: true }
  | { ok: false; error: string; status: 400 | 413 };

const OK: AttachmentCheckResult = { ok: true };

/** One file against the type and size limits, in isolation. */
export function checkAttachment(file: AttachmentFileLike): AttachmentCheckResult {
  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type as AllowedAttachmentType)) {
    return {
      ok: false,
      status: 400,
      error: `${file.name}: files of type "${file.type || "unknown"}" aren't supported.`,
    };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `${file.name} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB.`,
    };
  }
  return OK;
}

/** A batch of new files against the per-request count limit, then each one individually. */
export function checkBatch(
  existingCount: number,
  files: AttachmentFileLike[],
): AttachmentCheckResult {
  if (existingCount + files.length > MAX_ATTACHMENTS_PER_REQUEST) {
    return {
      ok: false,
      status: 400,
      error: `A request can have at most ${MAX_ATTACHMENTS_PER_REQUEST} attachments.`,
    };
  }
  for (const file of files) {
    const result = checkAttachment(file);
    if (!result.ok) return result;
  }
  return OK;
}
