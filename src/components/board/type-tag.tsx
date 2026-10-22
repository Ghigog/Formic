import { INK, TINT_WHITE, insectTint, type InsectColor } from "@/components/ui/tint";
import type { BugSeverity, WorkType } from "@/lib/domain/entities";

const LABELS: Record<WorkType, string> = {
  user_story: "User story",
  task: "Task",
  feature: "Feature",
  spike: "Spike",
  tech_debt: "Tech debt",
  bug: "Bug",
};

/**
 * Tag fills: a fixed light tint of an insect-palette colour (not a theme variable), so the
 * anthracite text reads in both themes. A bug stays crimson and gets a stronger tint as severity rises.
 */
const HUES: Record<Exclude<WorkType, "bug">, InsectColor> = {
  user_story: "jade",
  task: "moss",
  feature: "terracotta",
  spike: "ochre",
  tech_debt: "slate",
};
const BUG_WHITE: Record<BugSeverity, number> = {
  low: 0.8,
  medium: TINT_WHITE,
  high: 0.6,
  critical: 0.5,
};
const TEXT = INK;

/** The one coloured tag a card or the drawer shows for its type; a done bug reads SQUASHED. */
export function TypeTag({
  type,
  severity,
  squashed = false,
}: {
  type: WorkType;
  severity?: BugSeverity | null;
  squashed?: boolean;
}) {
  const bug = type === "bug";
  const label =
    bug && squashed
      ? "Squashed"
      : bug && severity
        ? `${LABELS[type]} · ${severity[0]!.toUpperCase()}${severity.slice(1)}`
        : LABELS[type];
  const background = bug ? insectTint("crimson", BUG_WHITE[severity ?? "medium"]) : insectTint(HUES[type]);
  const style =
    bug && squashed
      ? undefined
      : { backgroundColor: background, color: TEXT };
  return (
    <span
      data-type-tag={type}
      data-severity={bug ? (severity ?? undefined) : undefined}
      {...(bug && !squashed ? { "data-bugicon": "" } : {})}
      {...(type === "spike" ? { "data-spikeicon": "" } : {})}
      style={style}
      className={
        bug && squashed
          ? "bg-hairline text-muted inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[9px] tracking-[0.08em] whitespace-nowrap uppercase"
          : "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[9px] tracking-[0.08em] whitespace-nowrap uppercase"
      }
    >
      {label}
    </span>
  );
}
