"use client";

import { useRef, useState } from "react";
import { ALLOWED_ATTACHMENT_TYPES, checkBatch } from "@/lib/attachments/limits";
import type { AttachmentSummary } from "@/lib/domain/entities";
import { useMediaQuery } from "@/lib/hooks/use-media-query";

interface AttachmentItem {
  clientId: string;
  name: string;
  previewUrl: string | null;
  status: "uploading" | "done" | "error";
  /** Set once the upload has claimed a server-side id. */
  id?: string;
  error?: string;
}

/**
 * A thumbnail source for an image file, or null when the platform's
 * `URL.createObjectURL` cannot make one for it. Best-effort: the list still
 * shows the filename either way.
 */
function objectUrlFor(file: File): string | null {
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/** Turns a browser File into what /api/attachments's upload() expects. */
async function post(requestId: string, projectId: string, file: File): Promise<AttachmentSummary> {
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("projectId", projectId);
  form.set("file", file);
  const res = await fetch("/api/attachments", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as
    | { attachment: AttachmentSummary }
    | { error: string }
    | null;
  if (!res.ok || !body || !("attachment" in body)) {
    throw new Error((body && "error" in body && body.error) || "Could not attach that file.");
  }
  return body.attachment;
}

/**
 * Images, photos and files attached to a request before it is submitted, kept
 * under the dialog's requestId until the card it becomes claims them.
 *
 * Owns its own list: mounted fresh each time the dialog opens (its parent
 * returns null while closed, which unmounts this along with the rest of the
 * form), so there is nothing here to reset by hand.
 */
export function AttachmentPicker({ requestId }: { requestId: string }) {
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const projectId = useRef<Promise<string> | null>(null);
  /** Removed before its upload settled: the attachment must not outlive it. */
  const removed = useRef<Set<string>>(new Set());

  function activeProjectId(): Promise<string> {
    if (!projectId.current) {
      projectId.current = fetch("/api/projects", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: { active: { id: string } | null }) => {
          if (!d.active) throw new Error("Pick a repository first.");
          return d.active.id;
        });
    }
    return projectId.current;
  }

  async function upload(clientId: string, file: File) {
    try {
      const attachment = await post(requestId, await activeProjectId(), file);
      if (removed.current.has(clientId)) {
        removed.current.delete(clientId);
        void fetch(`/api/attachments/${attachment.id}?requestId=${encodeURIComponent(requestId)}`, {
          method: "DELETE",
        }).catch(() => {});
        return;
      }
      setItems((prev) =>
        prev.map((i) => (i.clientId === clientId ? { ...i, status: "done", id: attachment.id } : i)),
      );
    } catch (e) {
      setItems((prev) =>
        prev.map((i) =>
          i.clientId === clientId
            ? { ...i, status: "error", error: e instanceof Error ? e.message : "Could not attach that file." }
            : i,
        ),
      );
    }
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    let count = items.length;
    for (const file of Array.from(fileList)) {
      const check = checkBatch(count, [{ name: file.name, type: file.type, size: file.size }]);
      if (!check.ok) {
        setError(check.error);
        continue;
      }
      count += 1;
      setError(null);
      const clientId = crypto.randomUUID();
      const previewUrl = file.type.startsWith("image/") ? objectUrlFor(file) : null;
      setItems((prev) => [...prev, { clientId, name: file.name, previewUrl, status: "uploading" }]);
      void upload(clientId, file);
    }
  }

  function remove(item: AttachmentItem) {
    setItems((prev) => prev.filter((i) => i.clientId !== item.clientId));
    if (item.previewUrl) {
      try {
        URL.revokeObjectURL(item.previewUrl);
      } catch {
        // Best-effort: a preview that failed to revoke just outlives the tab.
      }
    }
    if (item.id) {
      void fetch(`/api/attachments/${item.id}?requestId=${encodeURIComponent(requestId)}`, {
        method: "DELETE",
      }).catch(() => {});
    } else if (item.status === "uploading") {
      removed.current.add(item.clientId);
    }
  }

  const controlClass =
    "border-line bg-card text-muted hover:border-terracotta hover:text-ink inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className={controlClass}>
          <PaperclipIcon />
          Attach files
          <input
            type="file"
            multiple
            accept={ALLOWED_ATTACHMENT_TYPES.join(",")}
            capture="environment"
            className="sr-only"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>

        {isMobile && (
          <label className={controlClass}>
            <CameraIcon />
            Take a photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>

      {error && (
        <p role="alert" className="text-crimson text-[12px]">
          {error}
        </p>
      )}

      {items.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li
              key={item.clientId}
              className="border-line bg-cream text-ink flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-1 text-[11px]"
            >
              {item.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.previewUrl} alt="" className="size-6 shrink-0 rounded-full object-cover" />
              ) : (
                <FileIcon />
              )}
              <span className="min-w-0 flex-1 truncate">
                {item.status === "uploading" ? `Attaching ${item.name}…` : item.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => remove(item)}
                className="text-muted hover:text-ink shrink-0 px-0.5"
              >
                ×
              </button>
              {item.status === "error" && (
                <p role="alert" className="text-crimson basis-full text-[11px]">
                  {item.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PaperclipIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M8.5 3.5 4 8a1.5 1.5 0 1 0 2.12 2.12l4.24-4.24a3 3 0 1 0-4.24-4.24L2 5.76"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2 4.5h1.2l.6-1h4.4l.6 1H10a.5.5 0 0 1 .5.5v4.5a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="6.5" r="1.6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M3 1.5h4l2 2v7a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-8.5a.5.5 0 0 1 .5-.5Z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
