"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui/cn";
import { checkBatch } from "@/lib/attachments/limits";
import type { AttachmentSummary } from "@/lib/domain/entities";
import { useFocusTrap } from "@/lib/hooks/use-focus-trap";
import { post } from "./attachment-picker";

/** What the PM chat takes: pictures only, not the files a card's request may carry. */
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

interface DraftImage {
  clientId: string;
  name: string;
  previewUrl: string | null;
  status: "uploading" | "done";
  id?: string;
}

function previewOf(file: File): string | null {
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function release(url: string | null) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // A preview that failed to revoke just outlives the tab.
  }
}

/**
 * The images on the PM composer's draft, kept under one requestId until the
 * message is sent and the server claims them. Same upload and limits as the
 * request dialog's picker (POST /api/attachments, `checkBatch`), narrowed to
 * images.
 */
export function useComposerImages() {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [items, setItems] = useState<DraftImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const projectId = useRef<Promise<string> | null>(null);
  /** Removed before its upload settled: the attachment must not outlive it. */
  const removed = useRef<Set<string>>(new Set());
  const current = useRef({ requestId, count: 0 });
  useEffect(() => {
    current.current = { requestId, count: items.length };
  }, [requestId, items.length]);

  const forget = useCallback((id: string, from: string) => {
    void fetch(`/api/attachments/${id}?requestId=${encodeURIComponent(from)}`, {
      method: "DELETE",
    }).catch(() => {});
  }, []);

  const upload = useCallback(
    async (clientId: string, file: File, from: string) => {
      try {
        projectId.current ??= fetch("/api/projects", { cache: "no-store" })
          .then((r) => r.json())
          .then((d: { active: { id: string } | null }) => {
            if (!d.active) throw new Error("Pick a repository first.");
            return d.active.id;
          });
        const attachment = await post(from, await projectId.current, file);
        if (removed.current.delete(clientId))
          return forget(attachment.id, from);
        setItems((prev) =>
          prev.map((i) =>
            i.clientId === clientId
              ? { ...i, status: "done", id: attachment.id }
              : i,
          ),
        );
      } catch (e) {
        projectId.current = null;
        setItems((prev) => prev.filter((i) => i.clientId !== clientId));
        setError(
          e instanceof Error ? e.message : "Could not attach that image.",
        );
      }
    },
    [forget],
  );

  const add = useCallback(
    (files: FileList | File[]) => {
      let count = current.current.count;
      for (const file of Array.from(files)) {
        const check = IMAGE_TYPES.includes(file.type)
          ? checkBatch(count, [
              { name: file.name, type: file.type, size: file.size },
            ])
          : ({
              ok: false,
              error: `${file.name || "That file"} is not a PNG, JPEG, GIF or WebP image.`,
            } as const);
        if (!check.ok) {
          setError(check.error);
          continue;
        }
        count += 1;
        setError(null);
        const clientId = crypto.randomUUID();
        setItems((prev) => [
          ...prev,
          {
            clientId,
            name: file.name,
            previewUrl: previewOf(file),
            status: "uploading",
          },
        ]);
        void upload(clientId, file, current.current.requestId);
      }
    },
    [upload],
  );

  const remove = useCallback(
    (item: DraftImage) => {
      setItems((prev) => prev.filter((i) => i.clientId !== item.clientId));
      release(item.previewUrl);
      setError(null);
      if (item.id) forget(item.id, current.current.requestId);
      else removed.current.add(item.clientId);
    },
    [forget],
  );

  /** The draft was sent: its images now belong to the message, so start a new one. */
  const reset = useCallback(() => {
    for (const i of items) release(i.previewUrl);
    setItems([]);
    setError(null);
    setRequestId(crypto.randomUUID());
  }, [items]);

  return {
    requestId,
    items,
    error,
    add,
    remove,
    reset,
    /** Something is still going up: sending now would leave it behind. */
    uploading: items.some((i) => i.status === "uploading"),
    hasImages: items.some((i) => i.status === "done"),
  };
}

export type ComposerImages = ReturnType<typeof useComposerImages>;

/** The draft's thumbnails, scrolling sideways when they do not fit. */
export function DraftImages({
  images,
  className,
}: {
  images: ComposerImages;
  className?: string;
}) {
  if (images.items.length === 0) return null;
  return (
    <ul
      className={cn(
        "m-0 flex w-full list-none gap-2 overflow-x-auto p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {images.items.map((item) => (
        <li key={item.clientId} className="relative shrink-0 pt-1.5 pr-1.5">
          <div
            data-status={item.status}
            className={cn(
              "border-line bg-card relative size-12 overflow-hidden rounded-lg border transition-opacity",
              item.status === "uploading" ? "opacity-50" : "opacity-100",
            )}
          >
            {item.previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.previewUrl}
                alt={item.name}
                className="size-full object-cover"
              />
            )}
            {item.status === "uploading" && (
              <span
                role="status"
                aria-label={`Uploading ${item.name}`}
                className="border-ink/60 absolute inset-0 m-auto size-4 animate-spin rounded-full border-2 border-t-transparent"
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => images.remove(item)}
            aria-label={`Remove ${item.name}`}
            className="border-line bg-cream text-ink hover:bg-column absolute top-0 right-0 inline-flex size-4 items-center justify-center rounded-full border text-[10px] leading-none"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The pictures on a sent message; a tap enlarges one. */
export function SentImages({ images }: { images: AttachmentSummary[] }) {
  const [enlarged, setEnlarged] = useState<AttachmentSummary | null>(null);
  const close = useCallback(() => setEnlarged(null), []);
  const trapKeys = useFocusTrap({ onEscape: close });
  const focusDialog = useCallback(
    (el: HTMLElement | null) => el?.focus({ preventScroll: true }),
    [],
  );
  const pictures = images.filter((a) => a.kind === "image");
  if (pictures.length === 0) return null;
  return (
    <>
      <ul className="m-0 mb-1.5 flex list-none flex-wrap justify-end gap-1.5 p-0">
        {pictures.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => setEnlarged(a)}
              aria-label={`Enlarge ${a.filename}`}
              className="border-line block size-16 overflow-hidden rounded-lg border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={a.url}
                alt={a.filename}
                className="size-full object-cover"
              />
            </button>
          </li>
        ))}
      </ul>
      {enlarged &&
        createPortal(
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <div
            role="dialog"
            aria-modal
            ref={focusDialog}
            tabIndex={-1}
            onKeyDown={trapKeys}
            aria-label={enlarged.filename}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6 outline-none"
          >
            <div
              role="presentation"
              className="absolute inset-0"
              onClick={close}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enlarged.url}
              alt={enlarged.filename}
              className="relative max-h-full max-w-full rounded-md object-contain"
            />
          </div>,
          document.body,
        )}
    </>
  );
}

export function PaperclipIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
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
