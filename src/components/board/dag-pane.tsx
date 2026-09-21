"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { CoinBadge } from "@/components/ui/coin-badge";
import { StatusPill } from "@/components/ui/status-pill";
import { PheromoneTrail, TrailLayer } from "@/components/ui/pheromone-trail";
import type { BoardCard } from "@/lib/domain/entities";
import { topologicalOrder } from "@/lib/domain/dag";

interface Anchor {
  id: string;
  left: { x: number; y: number };
  right: { x: number; y: number };
}

/**
 * The child ticket DAG with its file-boundary rules.
 *
 * Tickets are laid out in dependency order and connected by pheromone trails.
 * A trail lights when either endpoint is hovered, and pulses once when the
 * blocking ticket merges and releases the one below it.
 */
export function DagPane({
  children,
  recentlyUnblocked,
}: {
  children: BoardCard[];
  /** Ticket ids whose dependencies just cleared, for the one-shot pulse. */
  recentlyUnblocked?: Set<string>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hovered, setHovered] = useState<string | null>(null);

  const ordered = (() => {
    try {
      const order = topologicalOrder(
        children.map((c) => ({
          key: c.id,
          dependsOn: c.dependsOn,
          fileScope: c.fileScope,
        })),
      );
      const index = new Map(order.map((id, i) => [id, i]));
      return [...children].sort(
        (a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0),
      );
    } catch {
      // A cycle should be impossible past validation, but rendering must not
      // depend on that being true.
      return children;
    }
  })();

  // Trails are drawn from measured positions, so they are recomputed whenever
  // the list reflows rather than guessed from row height.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      const hostBox = host.getBoundingClientRect();
      const next: Anchor[] = [];

      for (const card of ordered) {
        const row = rowRefs.current.get(card.id);
        if (!row) continue;
        const box = row.getBoundingClientRect();
        next.push({
          id: card.id,
          left: { x: box.left - hostBox.left, y: box.top - hostBox.top + box.height / 2 },
          right: {
            x: box.right - hostBox.left,
            y: box.top - hostBox.top + box.height / 2,
          },
        });
      }

      setAnchors(next);
      setSize({ width: hostBox.width, height: host.scrollHeight });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    for (const row of rowRefs.current.values()) observer.observe(row);
    return () => observer.disconnect();
  }, [ordered.length, children]);

  const anchorFor = (id: string) => anchors.find((a) => a.id === id);

  if (children.length === 0) {
    return (
      <p className="text-fg-subtle p-4 text-[12px]">
        No child tickets yet. Move this Epic to To Do and the Architect Agent
        will break it down.
      </p>
    );
  }

  return (
    <div ref={hostRef} className="relative p-2">
      <TrailLayer width={size.width} height={size.height}>
        {ordered.flatMap((card) =>
          card.dependsOn.map((depId) => {
            const from = anchorFor(depId);
            const to = anchorFor(card.id);
            if (!from || !to) return null;
            return (
              <PheromoneTrail
                key={`${depId}->${card.id}`}
                // Trails leave the blocker's left edge and arrive at the
                // dependent's left edge, so they run down the gutter instead
                // of crossing the cards.
                from={{ x: from.left.x + 4, y: from.left.y }}
                to={{ x: to.left.x + 4, y: to.left.y }}
                active={hovered === depId || hovered === card.id}
                pulsing={recentlyUnblocked?.has(card.id) ?? false}
              />
            );
          }),
        )}
      </TrailLayer>

      <ul className="relative flex flex-col gap-1 pl-4">
        {ordered.map((card) => (
          <li
            key={card.id}
            ref={(el) => {
              if (el) rowRefs.current.set(card.id, el);
              else rowRefs.current.delete(card.id);
            }}
            onMouseEnter={() => setHovered(card.id)}
            onMouseLeave={() => setHovered(null)}
            className={cn(
              "p-card bg-surface border-line rounded-card border transition-colors",
              hovered === card.id && "border-ochre",
            )}
          >
            <div className="flex items-start gap-1">
              <span className="text-fg-subtle font-mono text-[10px]">
                {card.key}
              </span>
              {card.size && (
                <CoinBadge className="ml-auto" title="Ticket size">
                  {card.size}
                </CoinBadge>
              )}
            </div>

            <h4 className="text-fg mt-0.5 text-[13px] leading-5 font-medium">
              {card.title}
            </h4>

            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusPill status={card.status} />
              {card.dependsOn.length > 0 && (
                <span className="text-ochre-text text-[11px]">
                  blocked by{" "}
                  {card.dependsOn
                    .map((id) => children.find((c) => c.id === id)?.key ?? "?")
                    .join(", ")}
                </span>
              )}
            </div>

            {/* The file boundary is the concurrency contract, so it is shown
                on the ticket rather than buried in a detail view. */}
            <p className="text-fg-subtle mt-1 font-mono text-[10px]">
              limited to {card.fileScope.join(" · ") || "(no scope)"}
            </p>

            {card.blockedReason && (
              <p className="text-crimson-text mt-1 text-[11px] leading-4">
                {card.blockedReason}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
