"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Loads earlier messages without moving the reader: remembers how tall the
 * thread was, and once the first message changes (earlier ones were added
 * above it) moves the scroll position down by the height that was added.
 * New messages at the bottom leave the first message alone, so they keep
 * their own auto-scroll.
 */
export function useKeepPlace(firstId: string | undefined) {
  const list = useRef<HTMLDivElement>(null);
  const mark = useRef<{ height: number; firstId: string | undefined } | null>(null);
  useLayoutEffect(() => {
    const el = list.current;
    const m = mark.current;
    if (!m || !el || firstId === m.firstId) return;
    // A thread that emptied (cleared) has nothing to keep a place in.
    if (firstId !== undefined) el.scrollTop += el.scrollHeight - m.height;
    mark.current = null;
  }, [firstId]);
  const keepPlace = (load: () => Promise<void>) => {
    mark.current = list.current ? { height: list.current.scrollHeight, firstId } : null;
    return load();
  };
  return { list, keepPlace };
}

/** The top of a long thread: asks for the page before the one on screen. */
export function EarlierMessages({
  loading,
  error,
  onLoad,
}: {
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}) {
  return (
    <div className="space-y-1">
      {loading ? (
        <p className="text-muted text-[12px]">Loading…</p>
      ) : (
        <button
          type="button"
          onClick={onLoad}
          className="text-muted hover:text-ink -my-1 py-1 text-[12px] underline-offset-2 hover:underline"
        >
          Earlier messages
        </button>
      )}
      {error && (
        <p role="alert" className="text-crimson-text text-[12px]">
          {error}
        </p>
      )}
    </div>
  );
}
