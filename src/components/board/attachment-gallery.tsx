"use client";

import { useEffect, useState } from "react";
import type { AttachmentSummary } from "@/lib/domain/entities";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Every file attached to a card's request: a thumbnail with a
 * click-to-enlarge lightbox for images, a name/size/download chip for
 * everything else. Read-only here, matching the PRD's exclusion of adding
 * attachments after creation — uploading and deleting only happen from the
 * capture dialog, before a card exists to attach to.
 *
 * Fetched by owner rather than carried on the card, so it still lists what
 * a rerouted card was submitted with: T-1's attachment rows are reassigned
 * to the card that ends up owning the request, never copied.
 */
export function AttachmentGallery({
  epicId,
  ticketId,
}: {
  epicId?: string;
  ticketId?: string;
}) {
  const ownerId = epicId ?? ticketId ?? null;
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [enlarged, setEnlarged] = useState<AttachmentSummary | null>(null);

  // Another card: nothing of the last one's attachments stays on screen.
  const [loadedFor, setLoadedFor] = useState(ownerId);
  if (ownerId !== loadedFor) {
    setLoadedFor(ownerId);
    setAttachments([]);
    setEnlarged(null);
  }

  useEffect(() => {
    if (!ownerId) return;
    let live = true;
    const qs = epicId ? `epicId=${encodeURIComponent(epicId)}` : `ticketId=${encodeURIComponent(ticketId!)}`;
    fetch(`/api/attachments?${qs}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ attachments: AttachmentSummary[] }>) : null))
      .then((body) => {
        if (live && body) setAttachments(body.attachments);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId]);

  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlarged(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);

  if (attachments.length === 0) return null;

  const images = attachments.filter((a) => a.kind === "image");
  const files = attachments.filter((a) => a.kind !== "image");

  return (
    <div>
      <Heading>Attachments</Heading>

      {images.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {images.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setEnlarged(a)}
                aria-label={`Enlarge ${a.filename}`}
                className="border-line block size-16 overflow-hidden rounded-md border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={a.filename} className="size-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((a) => (
            <li
              key={a.id}
              className="border-line bg-surface flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12px]"
            >
              <span className="min-w-0 flex-1 truncate">{a.filename}</span>
              <span className="text-fg-subtle shrink-0 font-mono text-[10px]">{formatSize(a.size)}</span>
              <a
                href={a.url}
                download={a.filename}
                className="text-terracotta shrink-0 text-[11px] font-medium underline-offset-2 hover:underline"
              >
                Download
              </a>
            </li>
          ))}
        </ul>
      )}

      {enlarged && (
        <div
          role="dialog"
          aria-modal
          aria-label={enlarged.filename}
          onClick={() => setEnlarged(null)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enlarged.url}
            alt={enlarged.filename}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      )}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-fg-subtle font-mono text-[10px] tracking-wide uppercase">{children}</h3>;
}
