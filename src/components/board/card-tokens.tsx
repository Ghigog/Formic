"use client";

import { useEffect, useId, useState } from "react";
import { compact } from "@/components/ui/compact-number";
import { COLUMN_LABELS } from "@/lib/domain/status";
import type { ColumnId } from "@/lib/domain/status";
import type { StayTokens } from "@/lib/kpi/tokens";

interface CardTokensView {
  stays: StayTokens[];
  totalIn: number;
  totalOut: number;
  unreported: boolean;
}

const split = (tokensIn: number, tokensOut: number) =>
  `${compact(tokensIn)} in · ${compact(tokensOut)} out`;

/**
 * The tokens a card used in each column it went through, one row per stay
 * (like the Timeline above it), and a total. Fetched fresh, keyed by the
 * caller on the card's id and status so a move or a finished run refetches.
 */
export function CardTokens({ cardId, kind }: { cardId: string; kind: "ticket" | "epic" }) {
  const [tokens, setTokens] = useState<CardTokensView | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/cards/${cardId}/tokens?kind=${kind}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<CardTokensView>) : null))
      .then(
        (found) => live && Array.isArray(found?.stays) && setTokens(found),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [cardId, kind]);

  if (!tokens || tokens.stays.length === 0) return null;
  const total = tokens.totalIn + tokens.totalOut;
  return (
    <div>
      <h3 className="text-fg-subtle font-mono text-[10px] tracking-wide uppercase">Tokens</h3>
      <ul className="mt-1 space-y-1">
        {tokens.stays.map((s, i) => (
          <li key={i} className="flex justify-between gap-3 text-[12px]">
            <span className="font-medium">{COLUMN_LABELS[s.column as ColumnId] ?? s.column}</span>
            <Count tokensIn={s.tokensIn} tokensOut={s.tokensOut} />
          </li>
        ))}
      </ul>
      <div className="border-line mt-1 flex justify-between gap-3 border-t pt-1 text-[12px] font-semibold">
        <span>Total</span>
        {total === 0 && tokens.unreported ? (
          <span className="tabular-nums">–</span>
        ) : (
          <Count tokensIn={tokens.totalIn} tokensOut={tokens.totalOut} />
        )}
      </div>
      {tokens.unreported && (
        <p className="text-fg-muted mt-1 text-[12px]">
          Some answers came from an agent that doesn&apos;t report tokens
        </p>
      )}
    </div>
  );
}

/** A count that shows its in/out split on hover, focus or tap. */
function Count({ tokensIn, tokensOut }: { tokensIn: number; tokensOut: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const text = split(tokensIn, tokensOut);
  return (
    <span className="relative">
      <button
        type="button"
        title={text}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="tabular-nums"
      >
        {compact(tokensIn + tokensOut)}
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="border-line bg-card text-ink absolute right-0 bottom-full z-10 mb-1 rounded-lg border px-2 py-1 text-[11px] font-normal whitespace-nowrap"
        >
          {text}
        </span>
      )}
    </span>
  );
}
