import type { BugSeverity, WorkType } from "@/lib/domain/entities";

const LABELS: Record<WorkType, string> = {
  user_story: "User story",
  task: "Task",
  feature: "Feature",
  spike: "Spike",
  bug: "Bug",
};

/**
 * Tag colours: fixed Formic palette tones (not theme variables) so the dark text reads in both themes.
 * A bug steps up from the crimson chip to rust as severity rises.
 */
const COLORS: Record<Exclude<WorkType, "bug">, string> = {
  user_story: "#a5c8a7", // jade-line
  task: "#fbf0da", // clay-chip
  feature: "#ee9a62", // terracotta-lit
  spike: "#e0a33c", // clay-lit
};
const BUG_COLORS: Record<BugSeverity, string> = {
  low: "#fbeaea", // crimson-chip
  medium: "#f28b82", // crimson-chip-text in dark theme
  high: "#e85d54",
  critical: "#e65100", // rust
};
const TEXT = "#1c1917"; // anthracite

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
  const label = bug && squashed ? "Squashed" : LABELS[type];
  const background = bug ? BUG_COLORS[severity ?? "medium"] : COLORS[type];
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
