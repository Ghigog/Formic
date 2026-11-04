"use client";

import { useColony } from "@/components/colony/colony";
import { UNSUPPORTED_TITLE, useCall } from "@/components/call/call-provider";
import type { Meeting } from "@/lib/db/repository";

/** Where the coins land: the guests on the call bar. */
function flyCoins(coins: HTMLElement[]) {
  const from = coins.map((el) => el.getBoundingClientRect());
  // The bar renders after the call goes live.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const targets = [...document.querySelectorAll<HTMLElement>("[data-tour=call-bar] [role=listitem]")];
      from.forEach((r, i) => {
        const to = targets[Math.min(i + 1, targets.length - 1)]?.getBoundingClientRect();
        if (!to || r.width === 0) return;
        const clone = coins[i]!.cloneNode(true) as HTMLElement;
        Object.assign(clone.style, {
          position: "fixed",
          left: `${r.left}px`,
          top: `${r.top}px`,
          margin: "0",
          zIndex: "90",
          pointerEvents: "none",
        });
        document.body.append(clone);
        const dx = to.left + to.width / 2 - (r.left + r.width / 2);
        const dy = to.top + to.height / 2 - (r.top + r.height / 2);
        const flight = clone.animate(
          [
            { transform: "none", opacity: 1 },
            { transform: `translate(${dx}px, ${dy}px) scale(${to.width / r.width})`, opacity: 1 },
          ],
          { duration: 600, delay: i * 70, easing: "cubic-bezier(.3,.7,.3,1)", fill: "backwards" },
        );
        flight.onfinish = flight.oncancel = () => clone.remove();
      });
    }),
  );
}

/**
 * Join now: starts the meeting as a call in the PM chat with its guests on
 * it, and flies their coins from `source` to the call bar.
 */
export function JoinNow({
  meeting,
  source,
  className,
  onJoined,
}: {
  meeting: Meeting;
  /** The element holding the guest coins (`[data-mcoin]`) to fly. */
  source: () => HTMLElement | null;
  className: string;
  onJoined?: () => void;
}) {
  const c = useColony();
  const call = useCall();
  const disabled = !call || call.live || !call.supported;
  return (
    <button
      type="button"
      data-tour="meetings-join"
      disabled={disabled}
      title={call && !call.supported ? UNSUPPORTED_TITLE : call?.live ? "You are already on a call" : undefined}
      onClick={() => {
        if (!call) return;
        c?.sfx("chord");
        const coins = [...(source()?.querySelectorAll<HTMLElement>("[data-mcoin]") ?? [])];
        call.startMeeting({ id: meeting.id, guests: meeting.guests });
        if (coins.length && !c?.fx.reducedMotion) flyCoins(coins);
        onJoined?.();
      }}
      className={`${className} disabled:opacity-50`}
    >
      Join now
    </button>
  );
}
