import { cn } from "./cn";

/**
 * The octagonal coin badge — the 8-motif that frames every piece of ticket
 * metadata: size, model tag, PR number, EPIC and MERGED labels, column counts,
 * the logo mark.
 *
 * Two nested elements, both clipped to the same chamfer. `clip-path` cuts a
 * CSS border off at the diagonals, so the 1px edge has to be drawn inside the
 * clip: the outer element is the border colour with 1px of padding, the inner
 * is the fill.
 */

export type CoinTone = "neutral" | "epic" | "merged";

/** Ring colour, fill and label colour, per the artboard. */
const TONES: Record<CoinTone, { ring: string; fill: string; text: string }> = {
  neutral: { ring: "bg-line", fill: "bg-card", text: "text-muted" },
  epic: {
    ring: "bg-terracotta",
    fill: "bg-epic-chip",
    text: "text-epic-chip-text",
  },
  merged: {
    ring: "bg-jade",
    fill: "bg-jade-chip",
    text: "text-jade-chip-text",
  },
};

export function CoinBadge({
  children,
  tone = "neutral",
  /** Which surface the badge sits on. Only changes a neutral badge's fill. */
  ground = "card",
  title,
  className,
  outerClassName,
}: {
  children: React.ReactNode;
  tone?: CoinTone;
  ground?: "card" | "cream";
  title?: string;
  /** Applied to the inner element, where the padding and type live. */
  className?: string;
  outerClassName?: string;
}) {
  const t = TONES[tone];
  const fill = tone === "neutral" && ground === "cream" ? "bg-cream" : t.fill;

  return (
    <span
      title={title}
      className={cn("oct inline-flex p-px", t.ring, outerClassName)}
    >
      <span
        className={cn(
          "oct inline-flex items-center gap-1 px-[7px] py-[2px]",
          "font-mono text-[9px] whitespace-nowrap",
          fill,
          t.text,
          className,
        )}
      >
        {children}
      </span>
    </span>
  );
}
