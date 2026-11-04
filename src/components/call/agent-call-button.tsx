"use client";

import { AutoTour } from "@/components/onboarding/tour";
import { UNSUPPORTED_TITLE, useCall } from "@/components/call/call-provider";
import { guestLabel, type GuestId } from "@/lib/meetings/guests";

function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6.6 3.5h2.8l1.4 4-1.9 1.4a11 11 0 0 0 5.2 5.2l1.4-1.9 4 1.4v2.8a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A phone beside an agent: opens the general chat in call mode with that
 * agent as the first guest (or, on a live call, brings them in). The first
 * time one shows, the Ant gives the call tour.
 */
export function AgentCallButton({ guest }: { guest: GuestId }) {
  const call = useCall();
  if (!call) return null;
  const name = guestLabel(guest);
  const disabled = !call.supported || call.guests.includes(guest);
  return (
    <>
      <AutoTour id="call" delay={2500} />
      <button
        type="button"
        data-tour="agent-call"
        disabled={disabled}
        onClick={() => (call.live ? call.addGuest(guest) : call.start(guest))}
        aria-label={`Call the ${name}`}
        title={call.supported ? (call.guests.includes(guest) ? "On the call" : `Call the ${name}`) : UNSUPPORTED_TITLE}
        className="bg-card border-line text-ink hover:border-clay inline-flex size-11 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-50 disabled:hover:border-line md:size-8"
      >
        <PhoneIcon />
      </button>
    </>
  );
}
