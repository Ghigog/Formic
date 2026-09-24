"use client";

import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { cn } from "./cn";

const sizeListeners = new Set<() => void>();

function readSize(key: string): number | null {
  try {
    const saved = Number(window.localStorage.getItem(key));
    return saved > 0 ? saved : null;
  } catch {
    return null;
  }
}

/**
 * A size the person set by dragging a divider, kept in this browser so the
 * drawer opens the way they left it. The default stands during SSR, and
 * whenever storage is off.
 */
export function useStoredSize(key: string, initial: number): [number, (n: number) => void] {
  const [dragged, setDragged] = useState<number | null>(null);
  const saved = useSyncExternalStore(
    useCallback((onChange: () => void) => {
      sizeListeners.add(onChange);
      return () => sizeListeners.delete(onChange);
    }, []),
    () => readSize(key),
    () => null,
  );

  const set = useCallback(
    (n: number) => {
      setDragged(n);
      try {
        window.localStorage.setItem(key, String(Math.round(n)));
      } catch {
        // Storage is off; the size lasts until the drawer closes.
      }
    },
    [key],
  );

  return [dragged ?? saved ?? initial, set];
}

/**
 * A divider to drag between two panes. `axis` is the direction it moves:
 * "x" sits between side-by-side panes, "y" between stacked ones. It reports
 * the pointer's position inside `container`, and the arrow keys nudge it.
 */
export function SplitHandle({
  axis,
  container,
  value,
  min,
  max,
  onChange,
  toValue,
  label,
  className,
}: {
  axis: "x" | "y";
  container: RefObject<HTMLElement | null>;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  /** The pane's size for a pointer at `offset` px along `axis`, in a container `length` px long. */
  toValue: (offset: number, length: number) => number;
  label: string;
  className?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const offset = axis === "x" ? e.clientX - box.left : e.clientY - box.top;
    onChange(clamp(toValue(offset, axis === "x" ? box.width : box.height)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (max - min) / 20;
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const forward = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    // Moving the divider forward grows a pane before it and shrinks one after.
    const grows = toValue(1, 2) > toValue(0, 2);
    const sign = (e.key === forward) === grows ? 1 : -1;
    onChange(clamp(value + sign * step));
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      onKeyDown={onKeyDown}
      className={cn(
        "group bg-line hover:bg-amber focus-visible:bg-amber relative shrink-0 touch-none outline-none",
        axis === "x" ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
        className,
      )}
    >
      {/* A wider, invisible grip, so the thin line is easy to catch. */}
      <span
        aria-hidden
        className={cn("absolute", axis === "x" ? "inset-y-0 -left-1.5 w-3" : "inset-x-0 -top-1.5 h-3")}
      />
    </div>
  );
}

const MIN_PANE = 120;

/**
 * Two panes side by side from the dual-pane breakpoint up, with a divider
 * to set their widths. Below it the panes stack as tabs, full width, and
 * each pane's own classes decide which one shows.
 */
export function SideBySide({ storageKey, first, second }: { storageKey: string; first: ReactNode; second: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery("(min-width: 1024px)");
  const [percent, setPercent] = useStoredSize(`formic:${storageKey}:width`, 50);

  return (
    <div ref={box} className="flex min-h-0 flex-1">
      <div
        className="flex min-h-0 min-w-0 flex-1 *:min-w-0 *:flex-1 lg:flex-none"
        style={wide ? { width: `${percent}%` } : undefined}
      >
        {first}
      </div>
      <SplitHandle
        axis="x"
        container={box}
        value={percent}
        min={25}
        max={75}
        onChange={setPercent}
        toValue={(offset, length) => (offset / length) * 100}
        label="Resize the panes"
        className="hidden lg:block"
      />
      <div className="flex min-h-0 min-w-0 flex-1 *:min-w-0 *:flex-1">{second}</div>
    </div>
  );
}

/**
 * A scrolling pane with the card's chat pinned beneath it, and a divider
 * between them to set how tall the chat is.
 */
export function WithChat({
  storageKey,
  children,
  chat,
  fixed = false,
}: {
  storageKey: string;
  children: ReactNode;
  chat: ReactNode;
  /** Just an input bar, sized to itself: nothing to resize. */
  fixed?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useStoredSize(`formic:${storageKey}:chat`, 280);

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {chat && fixed && <div className="shrink-0">{chat}</div>}
      {chat && !fixed && (
        <>
          <SplitHandle
            axis="y"
            container={box}
            value={height}
            min={MIN_PANE}
            max={900}
            onChange={setHeight}
            toValue={(offset, length) => Math.min(length - MIN_PANE, length - offset)}
            label="Resize the chat"
          />
          <div className="flex shrink-0 flex-col" style={{ height, maxHeight: `calc(100% - ${MIN_PANE}px)` }}>
            {chat}
          </div>
        </>
      )}
    </div>
  );
}
