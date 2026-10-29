"use client";

import { useEffect, useRef, useState } from "react";
import { BoardShell } from "./board-shell";
import type { Account } from "./account-menu";
import type { BoardProps } from "@/lib/board/board-props";

export type SwapDirection = "down" | "up";

/** Vertical travel, in px, of a drag on the swap handle before it counts as a swap. */
const SWAP_DISTANCE = 60;

export interface SwappableBoardProps {
  account: Account;
  projectId: string;
  board: BoardProps;
}

/**
 * The board, swappable for the next or previous one in the repo picker's
 * order without a reload. Dragging the handle down (or Alt+↓) digs to the next
 * board, up (Alt+↑) back. The order is fetched on the first swap and frozen
 * for the streak, a run of swaps; the streak ends, and the board is recorded
 * as opened once, at the first interaction with it that is not a swap.
 */
export function SwappableBoard({ account, projectId, board }: SwappableBoardProps) {
  const [current, setCurrent] = useState({ projectId, board });
  const [digging, setDigging] = useState(false);
  const [slide, setSlide] = useState<SwapDirection | "bounce" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streak = useRef<string[] | null>(null);
  const busy = useRef(false);
  const shown = useRef(current.projectId);
  useEffect(() => {
    shown.current = current.projectId;
  }, [current.projectId]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const swap = async (direction: SwapDirection) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setSlide(null);
    try {
      if (!streak.current) {
        const res = await fetch("/api/projects");
        if (!res.ok) throw new Error("order");
        const body = (await res.json()) as { projects: Array<{ id: string }> };
        streak.current = body.projects.map((p) => p.id);
      }
      const order = streak.current;
      const target = order[order.indexOf(shown.current) + (direction === "down" ? 1 : -1)];
      if (!target) {
        setSlide("bounce");
        return;
      }
      setDigging(true);
      const res = await fetch("/api/projects/swap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: target }),
      });
      if (!res.ok) throw new Error("swap");
      const next = (await res.json()) as { project: { id: string }; board: BoardProps };
      setCurrent({ projectId: next.project.id, board: next.board });
      setSlide(direction);
    } catch {
      setError("Couldn't load that board. You're back on the previous one.");
    } finally {
      setDigging(false);
      busy.current = false;
    }
  };

  /* Anything but a swap ends the streak and records the board in view as opened. */
  const endStreak = (e: React.SyntheticEvent) => {
    if (!streak.current) return;
    if ((e.target as Element).closest?.("[data-swap-handle]")) return;
    if (e.type === "keydown" && isSwapKey(e as React.KeyboardEvent)) return;
    streak.current = null;
    void fetch("/api/projects/opened", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: shown.current }),
    }).catch(() => {});
  };

  const dragStart = useRef<number | null>(null);

  return (
    <div
      onPointerDownCapture={endStreak}
      onKeyDownCapture={(e) => {
        endStreak(e);
        if (isSwapKey(e)) {
          e.preventDefault();
          void swap(e.key === "ArrowDown" ? "down" : "up");
        }
      }}
      onInputCapture={endStreak}
      onDragStartCapture={endStreak}
    >
      <button
        type="button"
        data-swap-handle
        aria-label="Swap board: drag down for the next, up for the previous"
        className="fixed top-0 left-1/2 z-[60] h-3 w-24 -translate-x-1/2 cursor-grab touch-none rounded-b-full bg-anthracite/30"
        onPointerDown={(e) => {
          dragStart.current = e.clientY;
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerUp={(e) => {
          const start = dragStart.current;
          dragStart.current = null;
          if (start === null) return;
          const dy = e.clientY - start;
          if (Math.abs(dy) >= SWAP_DISTANCE) void swap(dy > 0 ? "down" : "up");
        }}
        onPointerCancel={() => (dragStart.current = null)}
      />
      <div
        key={current.projectId}
        className="board-swap"
        data-slide={slide ?? undefined}
        onAnimationEnd={() => setSlide(null)}
      >
        <BoardShell account={account} {...current.board} />
      </div>
      {digging && (
        <div
          data-testid="dirt-band"
          role="status"
          aria-label="Digging to the next board"
          className="bg-clay/80 fixed inset-x-0 top-0 z-[65] h-24 animate-pulse"
        />
      )}
      {error && (
        <div role="alert" className="pointer-events-none fixed top-[76px] right-0 left-0 z-[70] flex justify-center">
          <div className="bg-anthracite text-cream rounded-full px-4 py-2.5 text-[12px] font-semibold">{error}</div>
        </div>
      )}
    </div>
  );
}

function isSwapKey(e: React.KeyboardEvent): boolean {
  return e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp");
}
