"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui/cn";
import { useHydrated, useSound } from "@/components/colony/store";
import { GuideAnt } from "./guide-ant";
import {
  antSpot,
  bubblePlace,
  heading,
  nearestAngle,
  padded,
  walkSeconds,
  type Box,
  type Spot,
} from "./placement";
import { endTour, offerTour, activeTour, useActiveTour, useAntVoice } from "./store";
import { TOURS, type TourDef, type TourId } from "./tours";
import { attachVoice, mutter, speaks, whenHeard } from "./voice";

/** At most this many boxes are lit at once: the five columns, say. */
const MAX_HOLES = 5;
const HOLE_PAD = 8;
const TYPE_MS = 26;
/** How long a step waits for its target to appear before it is skipped. */
const FIND_TRIES = 12;
const FIND_MS = 150;

/**
 * The visible boxes carrying `data-tour="<target>"`, in viewport pixels, and
 * whether any such element exists at all, shown or hidden.
 */
export function findTargets(target: string): { boxes: Box[]; first: Element | null; exists: boolean } {
  const els = Array.from(document.querySelectorAll(`[data-tour~="${target}"]`));
  const shown = els.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  return {
    exists: els.length > 0,
    first: shown[0] ?? null,
    boxes: shown.slice(0, MAX_HOLES).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Where the ant appears: out of the nest when there is one, else in from the bottom left. */
function entrance(): Spot & { angle: number } {
  const nest = findTargets("colony").boxes[0];
  if (nest) return { x: nest.x + nest.w / 2, y: nest.y + nest.h / 2, face: 0, angle: 0 };
  return { x: -40, y: window.innerHeight - 90, face: 90, angle: 90 };
}

/**
 * The one tour on screen, wherever it was started from. Mounted once, in the
 * root layout, so a tour survives the screen under it re-rendering.
 */
export function TourHost() {
  const id = useActiveTour();
  const hydrated = useHydrated();

  // Browsers only allow sound after a gesture: the voice listens for it.
  useEffect(() => attachVoice(), []);

  if (!hydrated || !id) return null;
  return createPortal(<Tour key={id} def={TOURS[id]} onEnd={endTour} />, document.body);
}

/**
 * Plays a screen's tour the first time it is shown. Render it inside the
 * screen: mounting is opening. A tour already running is left to finish, and
 * this one waits its turn.
 */
export function AutoTour({ id, delay = 350 }: { id: TourId; delay?: number }) {
  const active = useActiveTour();
  useEffect(() => {
    if (active !== null) return;
    const t = setTimeout(() => offerTour(id), delay);
    return () => clearTimeout(t);
  }, [active, id, delay]);
  // Closing the screen ends its tour: there is nothing left to point at.
  useEffect(() => () => {
    if (activeTour() === id) endTour();
  }, [id]);
  return null;
}

interface AntState {
  x: number;
  y: number;
  angle: number;
  /** Seconds the current move takes; 0 jumps. */
  dur: number;
}

export function Tour({ def, onEnd }: { def: TourDef; onEnd: () => void }) {
  const [soundOn] = useSound();
  const [voiceOn, setVoiceOn] = useAntVoice();
  const [index, setIndex] = useState(0);
  // The steps this screen can show. One whose target is hidden here (a
  // desktop-only control on a phone) is dropped up front, and one whose
  // target never turns up is dropped when it is reached, so the counter
  // only counts what is shown and Back never lands on a skipped step.
  const [steps, setSteps] = useState(() =>
    def.steps.filter((s) => {
      const found = findTargets(s.target);
      return found.boxes.length > 0 || (!found.exists && !def.allThere);
    }),
  );
  const [holes, setHoles] = useState<Box[]>([]);
  const [ant, setAnt] = useState<AntState>(() => {
    const e = entrance();
    return { x: e.x, y: e.y, angle: e.angle, dur: 0 };
  });
  const [walking, setWalking] = useState(false);
  const [bubble, setBubble] = useState(false);
  const [typed, setTyped] = useState(0);
  const [entering, setEntering] = useState(false);
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const antRef = useRef(ant);
  const timers = useRef<{ walk?: number; type?: number; find?: number; end?: number }>({});
  const nextButton = useRef<HTMLButtonElement>(null);
  const voice = soundOn && voiceOn;
  const voiceRef = useRef(voice);
  const spoken = useRef(0);
  const reduced = prefersReducedMotion();

  const step = steps[index];
  const text = step?.text ?? "";
  const last = index === steps.length - 1;

  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  const clear = () => {
    const t = timers.current;
    window.clearTimeout(t.walk);
    window.clearTimeout(t.find);
    window.clearTimeout(t.end);
    window.clearInterval(t.type);
    spoken.current += 1;
  };

  const place = (next: AntState) => {
    antRef.current = next;
    setAnt(next);
  };

  function walk(to: Spot, then: () => void) {
    const from = antRef.current;
    const dur = reduced ? 0 : walkSeconds(from, to);
    window.clearTimeout(timers.current.walk);
    if (dur === 0) {
      place({ x: to.x, y: to.y, angle: nearestAngle(from.angle, to.face), dur: 0 });
      setWalking(false);
      then();
      return;
    }
    const travel = nearestAngle(from.angle, heading(from, to));
    place({ x: to.x, y: to.y, angle: travel, dur });
    setWalking(true);
    timers.current.walk = window.setTimeout(() => {
      place({ x: to.x, y: to.y, angle: nearestAngle(travel, to.face), dur: 0 });
      setWalking(false);
      then();
    }, dur * 1000);
  }

  function speak(line: string) {
    window.clearInterval(timers.current.type);
    const turn = ++spoken.current;
    setBubble(true);
    if (reduced) {
      setTyped(line.length);
      return;
    }
    setTyped(0);
    const type = () => {
      if (turn !== spoken.current) return;
      let n = 0;
      timers.current.type = window.setInterval(() => {
        n += 1;
        const ch = line[n - 1];
        if (voiceRef.current && ch && speaks(ch, n)) mutter(ch);
        setTyped(n);
        if (n >= line.length) window.clearInterval(timers.current.type);
      }, TYPE_MS);
    };
    // A tour that opens on its own has had no click yet, and the browser keeps
    // the page silent until one: hold the first line for it, so it is heard.
    if (voiceRef.current) whenHeard(type);
    else type();
  }

  function finish() {
    clear();
    setBubble(false);
    if (!def.endInNest) return onEnd();
    const nest = findTargets("colony").boxes[0];
    if (!nest) return onEnd();
    setHoles([padded(nest, HOLE_PAD)]);
    walk({ x: nest.x + nest.w / 2, y: nest.y + nest.h / 2 + 2, face: 180 }, () => {
      setEntering(true);
      timers.current.end = window.setTimeout(onEnd, reduced ? 0 : 900);
    });
  }

  function go(i: number, tries: number) {
    const s = steps[i];
    if (!s) return finish();
    let found = findTargets(s.target);
    if (found.first && tries === 0) {
      found.first.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      found = findTargets(s.target);
    }
    if (found.boxes.length === 0) {
      // Not rendered yet: wait a moment. Rendered but hidden (a desktop-only
      // control on a phone): move straight on.
      if (!found.exists && tries < FIND_TRIES) {
        timers.current.find = window.setTimeout(() => go(i, tries + 1), FIND_MS);
      } else if (i < steps.length - 1) {
        // The next step slides into this index; the effect below runs it.
        setSteps(steps.filter((x) => x !== s));
      } else {
        finish();
      }
      return;
    }
    const lit = found.boxes.map((b) => padded(b, HOLE_PAD));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setView({ w: vw, h: vh });
    setHoles(lit);
    setBubble(false);
    walk(antSpot(lit, s.side, vw, vh), () => {
      // What it points at may have moved while the ant walked (a panel
      // still sliding in): look again before talking.
      const again = findTargets(s.target).boxes.map((b) => padded(b, HOLE_PAD));
      if (again.length > 0 && JSON.stringify(again) !== JSON.stringify(lit)) {
        setHoles(again);
        const spot = antSpot(again, s.side, window.innerWidth, window.innerHeight);
        place({ x: spot.x, y: spot.y, angle: nearestAngle(antRef.current.angle, spot.face), dur: 0 });
      }
      speak(s.text);
    });
  }

  // Each step: find what it points at, walk there, then talk.
  const run = useEffectEvent((i: number) => go(i, 0));
  useEffect(() => {
    const raf = requestAnimationFrame(() => run(index));
    return () => {
      cancelAnimationFrame(raf);
      clear();
    };
  }, [index, steps]);

  // The page moved under the tour: keep the holes and the ant on their targets.
  const settle = useEffectEvent(() => {
    if (!step || walking || entering) return;
    const found = findTargets(step.target);
    if (found.boxes.length === 0) return;
    const lit = found.boxes.map((b) => padded(b, HOLE_PAD));
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setView({ w: vw, h: vh });
    setHoles(lit);
    const spot = antSpot(lit, step.side, vw, vh);
    place({ x: spot.x, y: spot.y, angle: nearestAngle(antRef.current.angle, spot.face), dur: 0 });
  });
  useEffect(() => {
    let raf = 0;
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => settle());
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, { capture: true });
    };
  }, []);

  // Only while the bubble is up: the ant is walking otherwise, and a second
  // quick click would skip a step it never got to talk about.
  const next = () => {
    if (!bubble) return;
    setBubble(false);
    if (last) finish();
    else setIndex(index + 1);
  };
  const back = () => {
    if (!bubble || index === 0) return;
    setBubble(false);
    setIndex(index - 1);
  };
  const finishLine = () => {
    window.clearInterval(timers.current.type);
    setTyped(text.length);
  };

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Escape") onEnd();
    else if (e.key === "ArrowRight" && bubble && !step?.waitFor) next();
    else if (e.key === "ArrowLeft" && bubble && index > 0) back();
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Keyboard users land on Next as each line appears.
  useEffect(() => {
    if (bubble) nextButton.current?.focus({ preventScroll: true });
  }, [bubble, index]);

  const spot: Spot = { x: ant.x, y: ant.y, face: ant.angle };
  const where = bubblePlace(spot, step?.side ?? "below", view.w, view.h);
  const talking = bubble && typed < text.length;
  const boardSteps = steps.length;

  return (
    <div data-testid="tour" className="pointer-events-none fixed inset-0 z-[1000]">
      <svg
        aria-hidden="true"
        width="100%"
        height="100%"
        className="absolute inset-0 transition-opacity duration-700"
        style={{ opacity: holes.length > 0 && !entering ? 1 : 0 }}
      >
        <defs>
          <filter id="tour-soil" filterUnits="userSpaceOnUse" x="0" y="0" width="4000" height="3000">
            <feFlood floodColor="#070504" result="base" />
            <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves={4} seed={9} result="clumpN" />
            <feColorMatrix in="clumpN" type="matrix" values="0 0 0 0 0.045  0 0 0 0 0.036  0 0 0 0 0.03  0.6 0 0 0 -0.24" result="clumps" />
            <feTurbulence type="turbulence" baseFrequency="0.035" numOctaves={2} seed={21} result="veinN" />
            <feColorMatrix in="veinN" type="matrix" values="0 0 0 0 0.02  0 0 0 0 0.014  0 0 0 0 0.01  0 0 0 -2 0.3" result="veins" />
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={3} result="grainN" />
            <feColorMatrix in="grainN" type="matrix" values="0 0 0 0 0.015  0 0 0 0 0.01  0 0 0 0 0.008  1.4 0 0 0 -0.5" result="darkGrain" />
            <feColorMatrix in="grainN" type="matrix" values="0 0 0 0 0.08  0 0 0 0 0.066  0 0 0 0 0.055  0 1 0 0 -0.72" result="lightGrain" />
            <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves={1} seed={40} result="pebN" />
            <feColorMatrix in="pebN" type="matrix" values="0 0 0 0 0.06  0 0 0 0 0.048  0 0 0 0 0.038  0 0 3 0 -2.1" result="pebbles" />
            <feMerge>
              <feMergeNode in="base" />
              <feMergeNode in="clumps" />
              <feMergeNode in="veins" />
              <feMergeNode in="pebbles" />
              <feMergeNode in="darkGrain" />
              <feMergeNode in="lightGrain" />
            </feMerge>
          </filter>
          <filter id="tour-rough" filterUnits="userSpaceOnUse" x="-200" y="-200" width="4400" height="3400">
            <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves={2} seed={5} result="t" />
            <feDisplacementMap in="SourceGraphic" in2="t" scale={11} xChannelSelector="R" yChannelSelector="G" result="d" />
            <feGaussianBlur in="d" stdDeviation="0.8" />
          </filter>
          <mask id="tour-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="4000" height="3000">
            <rect x="0" y="0" width="4000" height="3000" fill="#fff" />
            <g filter="url(#tour-rough)" fill="#000">
              {holes.map((h, i) => (
                <rect key={i} className="tour-hole" x={h.x} y={h.y} width={h.w} height={h.h} rx="14" />
              ))}
            </g>
          </mask>
        </defs>
        <rect x="0" y="0" width="4000" height="3000" filter="url(#tour-soil)" mask="url(#tour-holes)" opacity="0.98" />
        <g filter="url(#tour-rough)" fill="none" stroke="#050302" strokeWidth="5" opacity="0.45">
          {holes.map((h, i) => (
            <rect key={i} className="tour-hole" x={h.x} y={h.y} width={h.w} height={h.h} rx="14" />
          ))}
        </g>
        {/* A faint warm edge, so a hole over something dark (the nest) still reads as lit. */}
        <g filter="url(#tour-rough)" fill="none" stroke="#E0A33C" strokeWidth="1.5" opacity="0.35">
          {holes.map((h, i) => (
            <rect key={i} className="tour-hole" x={h.x - 2} y={h.y - 2} width={h.w + 4} height={h.h + 4} rx="15" />
          ))}
        </g>
      </svg>

      <div
        className="absolute z-[1] size-0"
        style={{
          left: ant.x,
          top: ant.y,
          transition: ant.dur ? `left ${ant.dur}s linear, top ${ant.dur}s linear` : undefined,
        }}
      >
        <div className={cn("absolute -top-8 -left-[26px]", entering && "guide-ant-enter")}>
          <div style={{ transform: `rotate(${ant.angle}deg)`, transition: "transform 0.3s ease" }}>
            <GuideAnt walking={walking} talking={talking} />
          </div>
        </div>
      </div>

      {bubble && step && (
        <div
          role="dialog"
          aria-label={`Tour: ${step.title}`}
          className="tour-bubble bg-card border-line pointer-events-auto absolute z-[2] box-border flex flex-col gap-2.5 rounded-xl border p-4 shadow-[0_14px_34px_rgba(12,10,9,0.38)]"
          style={{ left: where.x, top: where.y, width: where.w }}
        >
          {where.tail !== "none" && (
            <span
              aria-hidden
              className={cn(
                "bg-card border-line absolute size-3 rotate-45",
                where.tail === "left" && "-left-[7px] border-b border-l",
                where.tail === "right" && "-right-[7px] border-t border-r",
                where.tail === "top" && "-top-[7px] border-t border-l",
              )}
              style={where.tail === "top" ? { left: where.tailAt } : { top: where.tailAt }}
            />
          )}

          <div className="flex items-center gap-2">
            <span className="oct bg-terracotta inline-flex p-px">
              <span className="oct bg-epic-chip text-epic-chip-text px-2 py-0.5 font-mono text-[10px] font-medium tracking-[0.06em]">
                {boardSteps > 1 ? `${index + 1} / ${boardSteps}` : "HELLO"}
              </span>
            </span>
            <span className="text-ink flex-1 text-[13px] font-bold">{step.title}</span>
            <button
              type="button"
              onClick={() => setVoiceOn(!voiceOn)}
              aria-label={voiceOn ? "Mute the ant" : "Let the ant talk"}
              aria-pressed={!voiceOn}
              title={soundOn ? undefined : "Sound is off in Settings"}
              className="border-line text-muted hover:text-ink inline-flex size-8 items-center justify-center rounded-lg border"
            >
              <SpeakerIcon on={voiceOn && soundOn} />
            </button>
          </div>

          <p
            aria-live="polite"
            onClick={finishLine}
            className="text-ink m-0 min-h-[66px] text-[15px] leading-[1.5]"
          >
            {text.slice(0, typed)}
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onEnd}
              className="text-muted hover:text-ink h-9 px-1 text-[12px] font-medium"
            >
              Skip tour
            </button>
            <span className="flex-1" />
            {step.waitFor && <span className="text-muted text-[12px]">{step.waitFor}</span>}
            {index > 0 && (
              <button
                type="button"
                onClick={back}
                className="border-line bg-card text-ink hover:border-terracotta h-9 rounded-lg border px-3.5 text-[13px] font-semibold"
              >
                Back
              </button>
            )}
            {!step.waitFor && (
              <button
                ref={nextButton}
                type="button"
                onClick={next}
                className="bg-terracotta-cta h-9 rounded-lg px-4 text-[13px] font-semibold text-white"
              >
                {step.next ?? (last ? "Done" : "Next")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5z" />
      {on ? <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4" /> : <path d="M11 6l3.5 4M14.5 6L11 10" />}
    </svg>
  );
}
