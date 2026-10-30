"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useColony } from "./colony";
import { atRest, cordFor, createSwingDetector, stepSpring, tiltFor, type Spring } from "./bell-swing";

type BellState = { left: number; armed: boolean };
type RingResult = BellState & { sent?: number; skipped?: number };

async function postBell(action: "ring" | "arm" | "disarm"): Promise<RingResult | null> {
  try {
    const res = await fetch("/api/bell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return null;
    return (await res.json()) as RingResult;
  } catch {
    return null;
  }
}

const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** What the bell says after a ring, in a sentence. */
function rangLine(r: RingResult | null): string {
  if (!r) return "The bell would not ring. Try again in a moment.";
  const sent = r.sent ?? 0;
  if (sent === 0) return (r.skipped ?? 0) > 0 ? "Rang. Their agents are still out of usage, so nothing was sent." : "Rang. No card was waiting on a usage limit.";
  return `Rang. Told ${sent} ${sent === 1 ? "card" : "cards"} to carry on.`;
}

/**
 * The bell in the colony popover. It hangs from a hook with a cord beneath it:
 * grab the cord and swing it side to side and the bell swings with it, and a
 * full swing across and back rings it, so a stray tap never does. The silver
 * bell is free at every level: it tells every card stopped by a usage limit
 * to carry on. Tapping the bell itself arms a golden one, earned every five
 * levels, which rings itself a minute after a limit resets.
 */
export function Bell() {
  // The colony's own sound engine: it honours the sound switch and keeps the
  // audio alive where WebKit parks it (the desktop app, iPhone).
  const sfx = useColony()?.sfx;
  const [bell, setBell] = useState<BellState | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [cord, setCord] = useState({ x: 0, y: 0 });
  const [angle, setAngle] = useState(0);
  const [clapper, setClapper] = useState(0);
  const [ringing, setRinging] = useState(0);
  const grab = useRef<{ x: number; y: number; id: number } | null>(null);
  const swing = useRef(createSwingDetector());
  const spring = useRef<Spring>({ angle: 0, velocity: 0 });
  const lag = useRef<Spring>({ angle: 0, velocity: 0 });
  const target = useRef(0);
  const frame = useRef<number | null>(null);
  const gradient = useId().replace(/:/g, "");

  useEffect(() => {
    let live = true;
    fetch("/api/bell")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: BellState | null) => live && b && setBell({ left: b.left, armed: b.armed }))
      .catch(() => {});
    return () => {
      live = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 5000);
    return () => clearTimeout(t);
  }, [said]);

  /** Runs the bell's springs until it hangs still again. */
  const animate = () => {
    if (frame.current !== null || reducedMotion()) {
      if (reducedMotion()) setAngle(target.current);
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      spring.current = stepSpring(spring.current, target.current, dt);
      lag.current = stepSpring(lag.current, spring.current.angle, dt, 220, 9);
      setAngle(spring.current.angle);
      setClapper(lag.current.angle - spring.current.angle);
      if (grab.current === null && atRest(spring.current, target.current) && atRest(lag.current, spring.current.angle)) {
        frame.current = null;
        setAngle(target.current);
        setClapper(0);
        return;
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };

  const ring = () => {
    sfx?.("bell", 1);
    setRinging((n) => n + 1);
    void postBell("ring").then((r) => {
      if (r) setBell({ left: r.left, armed: r.armed });
      setSaid(rangLine(r));
    });
  };

  const onSwing = (event: ReturnType<ReturnType<typeof createSwingDetector>["move"]>) => {
    if (event === "ring") ring();
    else if (event === "swing" && swing.current.swings > 2) sfx?.("bell", 0.45);
  };

  const press = (e: React.PointerEvent) => {
    grab.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    swing.current.start(e.clientX);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const drag = (e: React.PointerEvent) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    const next = cordFor(e.clientX - g.x, e.clientY - g.y);
    setCord(next);
    target.current = tiltFor(next.x);
    animate();
    onSwing(swing.current.move(e.clientX));
  };
  const letGo = (e: React.PointerEvent) => {
    const g = grab.current;
    if (!g || g.id !== e.pointerId) return;
    grab.current = null;
    // A tap that never swung: the bell only sways, so a misclick never rings it.
    if (swing.current.swings === 0 && Math.abs(e.clientX - g.x) < 4) spring.current.velocity += 60;
    setCord({ x: 0, y: 0 });
    target.current = 0;
    animate();
  };
  /** The keyboard's swing: alternate the left and right arrows, as a hand would swing the cord. */
  const keyIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swingByKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    if (keyIdle.current === null) swing.current.start(0);
    else clearTimeout(keyIdle.current);
    const x = (e.key === "ArrowLeft" ? -1 : 1) * 30;
    target.current = tiltFor(x);
    animate();
    onSwing(swing.current.move(x));
    keyIdle.current = setTimeout(() => {
      keyIdle.current = null;
      target.current = 0;
      animate();
    }, 700);
  };

  const toggleArmed = async () => {
    if (!bell) return;
    if (!bell.armed && bell.left === 0) {
      setSaid("No golden bell yet: one comes every five levels.");
      return;
    }
    spring.current.velocity += bell.armed ? -40 : 40;
    animate();
    const next = await postBell(bell.armed ? "disarm" : "arm");
    if (next) {
      setBell({ left: next.left, armed: next.armed });
      setSaid(next.armed ? "Golden bell armed. It rings itself a minute after a usage limit resets." : "Back to silver.");
    }
  };

  const armed = !!bell?.armed;
  const cordEnd = { x: 48 + cord.x, y: 122 + cord.y };
  // The cord hangs from the clapper's foot, which swings with the bell about the hook.
  const tilt = ((angle + clapper) * Math.PI) / 180;
  const cordTop = { x: 48 - Math.sin(tilt) * 58, y: 18 + Math.cos(tilt) * 58 };
  const golden = bell ? `${bell.left} golden ${bell.left === 1 ? "bell" : "bells"} left` : "";

  return (
    <section aria-label="Bells" className="bg-panel flex items-center gap-4 rounded-lg px-3 py-3">
      <div className="relative h-[140px] w-[96px] shrink-0 select-none" data-testid="bell-rig" data-armed={armed || undefined}>
        <svg viewBox="0 0 96 140" width="96" height="140" aria-hidden="true" className="overflow-visible">
          <defs>
            <linearGradient id={`${gradient}-metal`} x1="0" x2="1">
              {armed ? (
                <>
                  <stop offset="0" stopColor="#f7df8f" />
                  <stop offset="0.45" stopColor="#c99a2e" />
                  <stop offset="0.7" stopColor="#f3d374" />
                  <stop offset="1" stopColor="#a87b1c" />
                </>
              ) : (
                <>
                  <stop offset="0" stopColor="#f4f2ed" />
                  <stop offset="0.45" stopColor="#b9b4ab" />
                  <stop offset="0.7" stopColor="#e9e5dd" />
                  <stop offset="1" stopColor="#9c968c" />
                </>
              )}
            </linearGradient>
          </defs>
          {/* The hook it hangs from. */}
          <path d="M34 6h28" stroke="var(--text)" strokeWidth="3" strokeLinecap="round" />
          <path d="M48 6v8a4 4 0 1 0 4 4" fill="none" stroke="var(--text)" strokeWidth="2" strokeLinecap="round" />
          <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: "48px 18px" }}>
            {/* Sound, on a ring: arcs that open out from the lip and fade. */}
            {ringing > 0 && (
              <g key={ringing} className="bell-waves" fill="none" stroke="var(--clay)" strokeWidth="1.5" strokeLinecap="round">
                <path d="M20 46q-6 10 0 20" />
                <path d="M76 46q6 10 0 20" />
                <path d="M13 42q-9 14 0 28" />
                <path d="M83 42q9 14 0 28" />
              </g>
            )}
            <rect x="44" y="20" width="8" height="7" rx="2" fill="var(--text)" />
            <path
              d="M48 26c-10 0-17 12-17 28v6l-6 8h46l-6-8v-6c0-16-7-28-17-28Z"
              fill={`url(#${gradient}-metal)`}
              stroke="var(--text)"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path d="M38 36c-2 5-3 11-3 18" fill="none" stroke="#fff" strokeOpacity="0.7" strokeWidth="2.2" strokeLinecap="round" />
            <ellipse cx="48" cy="68" rx="23" ry="3" fill="var(--text)" fillOpacity="0.18" />
            {armed && <circle className="bell-glint" cx="41" cy="40" r="2.2" fill="#fff" />}
            <g style={{ transform: `rotate(${clapper}deg)`, transformOrigin: "48px 30px" }}>
              <path d="M48 30v40" stroke="var(--text)" strokeWidth="1.4" />
              <circle cx="48" cy="72" r="4" fill="var(--text)" />
            </g>
          </g>
          {/* The cord, braided in the colony's clay, and its wooden toggle. */}
          <path
            d={`M${cordTop.x} ${cordTop.y} Q ${(cordTop.x + cordEnd.x) / 2 + cord.x * 0.15} ${(cordTop.y + cordEnd.y) / 2 + 6} ${cordEnd.x} ${cordEnd.y}`}
            fill="none"
            stroke="var(--clay)"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeDasharray="3 2"
          />
          <rect
            x={cordEnd.x - 4}
            y={cordEnd.y}
            width="8"
            height="14"
            rx="4"
            fill="var(--terracotta-deep)"
            stroke="var(--text)"
            strokeWidth="1"
            style={{ transform: `rotate(${-cord.x * 0.6}deg)`, transformOrigin: `${cordEnd.x}px ${cordEnd.y}px` }}
          />
        </svg>
        <button
          type="button"
          aria-label={armed ? "Golden bell, armed: tap to put it back to silver" : `Bell: tap to arm a golden bell, ${golden}`}
          aria-pressed={armed}
          onClick={() => void toggleArmed()}
          className="absolute top-[18px] left-[22px] h-[54px] w-[52px] cursor-pointer rounded-full"
        />
        <button
          type="button"
          aria-label="Bell cord: swing it side to side to ring the bell"
          aria-describedby={`${gradient}-how`}
          onPointerDown={press}
          onPointerMove={drag}
          onPointerUp={letGo}
          onPointerCancel={letGo}
          onKeyDown={swingByKey}
          style={{ touchAction: "none" }}
          className="absolute bottom-0 left-[8px] h-[64px] w-[80px] cursor-grab rounded-md active:cursor-grabbing"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-ink font-serif text-[16px] leading-tight font-semibold">{armed ? "Golden bell" : "Silver bell"}</span>
        <p id={`${gradient}-how`} className="text-muted text-[12px] leading-[1.45]">
          {armed
            ? "Armed. It rings itself a minute after a usage limit resets, then it's used up."
            : "Swing the cord to tell every card stopped by a usage limit to carry on."}
        </p>
        <span className="text-muted font-mono text-[10px]">
          {golden}
          {bell && !armed ? (bell.left > 0 ? " · tap the bell to arm one" : " · one every five levels") : ""}
        </span>
        <p role="status" className="text-ink min-h-[18px] text-[12px] font-semibold">
          {said ?? ""}
        </p>
      </div>
    </section>
  );
}
