import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

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
