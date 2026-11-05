import type { SwapAim } from "./swap-gesture";

/**
 * Where to drag to switch boards: the timeline's live ping inside an octagonal
 * coin, with its label above, centred on the point where releasing would swap.
 * It turns terracotta and stops pinging once the drag is there. Not shown when
 * that point is above the window: leaving the window cancels the drag.
 */
export function SwapHint({ aim }: { aim: SwapAim | null }) {
  if (!aim || aim.y < 0) return null;
  return (
    <div
      data-testid="swap-hint"
      data-armed={aim.armed}
      aria-hidden
      className="pointer-events-none fixed z-[70] flex -translate-x-1/2 -translate-y-1/2 animate-[swapHintIn_150ms_ease-out]"
      style={{ left: aim.x, top: aim.y }}
    >
      <span
        className={`absolute bottom-full mb-1.5 font-mono text-[9px] tracking-[0.1em] whitespace-nowrap uppercase ${
          aim.armed ? "text-terracotta" : "text-anthracite"
        }`}
      >
        Drag here to switch boards
      </span>
      <span className={`oct flex size-8 items-center justify-center ${aim.armed ? "bg-terracotta" : "bg-anthracite"}`}>
        <span className="relative size-2.5">
          {!aim.armed && (
            <span className="bg-clay absolute -top-1 -left-1 size-[18px] animate-[tlPing_1.8s_ease-out_infinite] rounded-full motion-reduce:hidden" />
          )}
          <span className={`absolute inset-0 rounded-full ${aim.armed ? "bg-on-anthracite" : "bg-clay"}`} />
        </span>
      </span>
    </div>
  );
}
