import type { SwapAim } from "./swap-gesture";

/** Height of the top app bar, in px: a touch hint stays below it. */
const APP_BAR = 64;
/** Gap, in px, between the coin and the screen's edge. */
const EDGE = 16;
const COIN = 32;

/**
 * Where to drag (or swipe) to switch boards: the timeline's live ping inside an octagonal
 * coin, with its label above, centred on the point where releasing would swap.
 * It turns terracotta and stops pinging once the drag is there. Not shown when
 * that point is above the window: leaving the window cancels the drag.
 *
 * A swipe's release point can sit under the person's own hand, so a touch aim
 * draws a guide line across the screen at that height and puts the coin on it,
 * at the side away from the fingers, kept on screen.
 */
export function SwapHint({ aim }: { aim: SwapAim | null }) {
  if (!aim) return null;
  if (aim.touch) return <TouchHint aim={aim} />;
  if (aim.y < 0) return null;
  return (
    <div
      data-testid="swap-hint"
      data-armed={aim.armed}
      aria-hidden
      className="swap-hint pointer-events-none fixed z-[70] flex -translate-x-1/2 -translate-y-1/2"
      style={{ left: aim.x, top: aim.y }}
    >
      <span
        className={`absolute bottom-full mb-1.5 font-mono text-[10px] tracking-[0.1em] whitespace-nowrap uppercase ${
          aim.armed ? "text-terracotta" : "text-anthracite"
        }`}
      >
        Drag here to switch boards
      </span>
      <Coin armed={aim.armed} />
    </div>
  );
}

function Coin({ armed }: { armed: boolean }) {
  return (
    <span className={`oct flex size-8 items-center justify-center ${armed ? "bg-terracotta" : "bg-anthracite"}`}>
      <span className="relative size-2.5">
        {!armed && (
          <span className="bg-clay absolute -top-1 -left-1 size-[18px] animate-[tlPing_1.8s_ease-out_infinite] rounded-full motion-reduce:hidden" />
        )}
        <span className={`absolute inset-0 rounded-full ${armed ? "bg-on-anthracite" : "bg-clay"}`} />
      </span>
    </span>
  );
}

function TouchHint({ aim }: { aim: SwapAim }) {
  const fingersLeft = aim.x < window.innerWidth / 2;
  const y = Math.min(Math.max(aim.y, APP_BAR), window.innerHeight - EDGE - COIN / 2);
  return (
    <>
      <div
        data-testid="swap-hint-line"
        data-armed={aim.armed}
        aria-hidden
        className={`swap-hint pointer-events-none fixed right-0 left-0 z-[70] h-px ${aim.armed ? "bg-terracotta" : "bg-anthracite"}`}
        style={{ top: y }}
      />
      <div
        data-testid="swap-hint"
        data-armed={aim.armed}
        aria-hidden
        className="swap-hint pointer-events-none fixed z-[70] flex -translate-y-1/2"
        style={{ top: y, ...(fingersLeft ? { right: EDGE } : { left: EDGE }) }}
      >
        <span
          className={`absolute bottom-full mb-1.5 font-mono text-[10px] tracking-[0.1em] whitespace-nowrap uppercase ${
            fingersLeft ? "right-0" : "left-0"
          } ${aim.armed ? "text-terracotta" : "text-anthracite"}`}
        >
          Release here to switch boards
        </span>
        <Coin armed={aim.armed} />
      </div>
    </>
  );
}
