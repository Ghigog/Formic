"use client";

import { useEffect, useRef, useState } from "react";
import { BoardShell } from "./board-shell";
import type { Account } from "./account-menu";
import { DigTransition, type DigTransitionHandle } from "./dig-transition";
import { createSwapGestures } from "./swap-gesture";
import type { SwapDirection } from "./swap-order";
import type { BoardProps } from "@/lib/board/board-props";

export type { SwapDirection } from "./swap-order";

export interface SwappableBoardProps {
  account: Account;
  projectId: string;
  board: BoardProps;
}

/**
 * The board, swappable for the next or previous one in the repo picker's
 * order without a reload: a three-finger swipe up (or a right-button drag up)
 * digs down to the next board, down goes back up. The board follows the hand
 * as it moves, and the swap itself is a dig through the colony's earth (see
 * DigTransition). The order is fetched on the first swap and frozen for the
 * streak, a run of swaps; the streak ends, and the board is recorded as
 * opened once, at the first interaction with it that is not a swap.
 */
export function SwappableBoard({ account, projectId, board }: SwappableBoardProps) {
  const [current, setCurrent] = useState({ projectId, board });
  const [error, setError] = useState<string | null>(null);
  const streak = useRef<string[] | null>(null);
  const names = useRef(new Map<string, string>());
  const busy = useRef(false);
  const shown = useRef(current.projectId);
  const dig = useRef<DigTransitionHandle>(null);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const swap = async (direction: SwapDirection) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      if (!streak.current) {
        const res = await fetch("/api/projects");
        if (!res.ok) throw new Error("order");
        const body = (await res.json()) as { projects: Array<{ id: string; name?: string | null; repoFullName?: string | null }> };
        streak.current = body.projects.map((p) => p.id);
        for (const p of body.projects) names.current.set(p.id, p.name || p.repoFullName?.split("/").pop() || "");
      }
      const order = streak.current;
      const target = order[order.indexOf(shown.current) + (direction === "down" ? 1 : -1)];
      if (!target) {
        dig.current?.bounce(direction);
        return;
      }
      const load = fetch("/api/projects/swap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: target }),
      }).then(async (res) => {
        if (!res.ok) throw new Error("swap");
        return (await res.json()) as { project: { id: string }; board: BoardProps };
      });
      const arrived = await dig.current!.swap(
        direction,
        load,
        (next) => {
          shown.current = next.project.id;
          setCurrent({ projectId: next.project.id, board: next.board });
        },
        names.current.get(target) || undefined,
      );
      if (!arrived) setError("Couldn't load that board. You're back on the previous one.");
    } catch {
      setError("Couldn't load that board. You're back on the previous one.");
    } finally {
      busy.current = false;
    }
  };
  const swapRef = useRef(swap);
  useEffect(() => {
    swapRef.current = swap;
  });

  // Native listeners: a three-finger move must stop the page scrolling under
  // it, which a passive (React) touch listener cannot do.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const g = createSwapGestures(
      (direction) => void swapRef.current(direction),
      (px) => dig.current?.pull(px),
    );
    const touchStart = (e: TouchEvent) => g.touchStart(e, el);
    const touchMove = (e: TouchEvent) => {
      if (g.touchMove(e)) e.preventDefault();
    };
    const touchEnd = (e: TouchEvent) => g.touchEnd(e);
    const touchCancel = () => g.touchCancel();
    const pointerDown = (e: PointerEvent) => g.pointerDown(e, el);
    const pointerMove = (e: PointerEvent) => g.pointerMove(e);
    const pointerUp = (e: PointerEvent) => g.pointerUp(e);
    const contextMenu = (e: MouseEvent) => g.contextMenu(e);
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", touchMove, { passive: false });
    el.addEventListener("touchend", touchEnd);
    el.addEventListener("touchcancel", touchCancel);
    el.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    el.addEventListener("contextmenu", contextMenu);
    return () => {
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("touchend", touchEnd);
      el.removeEventListener("touchcancel", touchCancel);
      el.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      el.removeEventListener("contextmenu", contextMenu);
    };
  }, []);

  /*
   * Anything but a swap ends the streak and records the board in view as
   * opened. A click, not a press: every finger of a three-finger swipe and
   * the right button of a drag press too, and neither clicks.
   */
  const endStreak = () => {
    if (!streak.current || busy.current) return;
    streak.current = null;
    void fetch("/api/projects/opened", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: shown.current }),
    }).catch(() => {});
  };

  return (
    <div ref={stage} onClickCapture={endStreak} onKeyDownCapture={endStreak} onInputCapture={endStreak} onDragStartCapture={endStreak}>
      <DigTransition ref={dig}>
        <BoardShell key={current.projectId} account={account} {...current.board} />
      </DigTransition>
      {error && (
        <div role="alert" className="pointer-events-none fixed top-[76px] right-0 left-0 z-[80] flex justify-center px-4">
          <div className="bg-anthracite text-cream rounded-full px-4 py-2.5 text-[12px] font-semibold shadow-lg">{error}</div>
        </div>
      )}
    </div>
  );
}
