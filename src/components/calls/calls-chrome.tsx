import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { guestLabel, type GuestId } from "@/lib/calls/guests";

/** The octagon every Formic badge is cut to (design/DESIGN.md: octagonal coin badge). */
export const OCTAGON =
  "[clip-path:polygon(9px_0,calc(100%-9px)_0,100%_9px,100%_calc(100%-9px),calc(100%-9px)_100%,9px_100%,0_calc(100%-9px),0_9px)]";

/** The calls pages' top bar: the way back, the page's name, and its one action. */
export function CallsHeader({ back, title, kicker, action }: { back: { href: Route; label: string }; title: string; kicker?: string; action?: ReactNode }) {
  return (
    <header className="border-line bg-card sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b px-4 md:px-6">
      <Link
        href={back.href}
        aria-label={back.label}
        className="border-line bg-cream text-ink inline-flex size-9 shrink-0 items-center justify-center rounded-lg border"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M8.5 3 4.5 7l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>
      <div className="flex min-w-0 flex-1 flex-col">
        {kicker && <span className="text-muted font-mono text-[10px] tracking-[0.1em] uppercase">{kicker}</span>}
        <h1 className="text-ink truncate font-serif text-[20px] leading-tight font-semibold">{title}</h1>
      </div>
      {action}
    </header>
  );
}

/** Each guest's colour: the column agents in the board's own, the PM in anthracite, Sentinels in jade. */
function guestInk(id: GuestId): { ground: string; ink: string } {
  if (id === "assistant" || id === "pm") return { ground: "var(--anthracite)", ink: "var(--cream)" };
  if (id.startsWith("sentinel:")) return { ground: "var(--jade)", ink: "#fff" };
  if (id === "product") return { ground: "var(--terracotta-cta)", ink: "#fff" };
  if (id === "architect") return { ground: "var(--clay)", ink: "#fff" };
  if (id === "coder") return { ground: "var(--rust)", ink: "#fff" };
  return { ground: "var(--terracotta-deep)", ink: "#fff" };
}

/** A guest's coin: their initials on their colour, cut to the octagon. */
export function GuestCoin({ id, size = 28 }: { id: GuestId; size?: number }) {
  const label = guestLabel(id);
  const initials = label.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const { ground, ink } = guestInk(id);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center font-mono font-semibold ${OCTAGON}`}
      style={{ width: size, height: size, background: ground, color: ink, fontSize: Math.round(size * 0.36) }}
    >
      {initials}
    </span>
  );
}
